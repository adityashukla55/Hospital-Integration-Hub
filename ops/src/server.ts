/**
 * Hub ops console.
 *
 *   GET  /                          console (static page)
 *   GET  /api/summary               status counts, open dead letters, latency
 *   GET  /api/messages?status=&type=&q=&limit=
 *   GET  /api/messages/:id          one message with raw HL7, issues, FHIR locations, dead letters
 *   GET  /api/dead-letters?open=1
 *   POST /api/messages/:id/replay   re-process one message (via OIE "Hub 5 - Replay")
 *   POST /api/dead-letters/replay   {"code": "TERMINOLOGY_UNMAPPED"} re-process all open dead letters (optionally by code)
 *   GET  /metrics                   Prometheus
 *   GET  /healthz
 */
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { parseOieStatistics, render, type Metric } from './metrics.ts';

const PORT = Number(process.env.PORT ?? 8088);
const pool = new pg.Pool({ connectionString: process.env.HUB_DB_URL ?? 'postgres://hub:hub@localhost:5432/hub', max: 5 });
const REPLAY_URL = process.env.REPLAY_URL ?? 'http://localhost:8091/replay/';
const FHIR_PUBLIC_URL = (process.env.FHIR_PUBLIC_URL ?? 'http://localhost:8080/fhir').replace(/\/+$/, '');
const OIE_URL = process.env.OIE_URL ?? 'https://localhost:8443';
const OIE_AUTH = 'Basic ' + Buffer.from(`${process.env.OIE_USER ?? 'admin'}:${process.env.OIE_PASSWORD ?? 'admin'}`).toString('base64');
const consoleHtml = readFileSync(fileURLToPath(new URL('./console.html', import.meta.url)), 'utf8');

const HUB_CHANNELS = new Map([
  ['b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0001', 'Hub 1 - Inbound'],
  ['b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0002', 'Hub 2 - Transform'],
  ['b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0003', 'Hub 3 - Deliver'],
  ['b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0004', 'Hub 4 - Dead Letter'],
  ['b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0005', 'Hub 5 - Replay']
]);

type Handler = (req: http.IncomingMessage, url: URL, params: string[]) => Promise<[number, unknown, string?]>;
const routes: Array<[string, RegExp, Handler]> = [];
const route = (method: string, pattern: RegExp, h: Handler) => routes.push([method, pattern, h]);

route('GET', /^\/healthz$/, async () => {
  await pool.query('SELECT 1');
  return [200, { ok: true }];
});

route('GET', /^\/$/, async () => [200, consoleHtml, 'text/html; charset=utf-8']);

route('GET', /^\/api\/summary$/, async () => {
  const [byStatus, byType, dead, latency] = await Promise.all([
    pool.query(`SELECT status, count(*)::int AS n FROM hub.message GROUP BY status ORDER BY status`),
    pool.query(`SELECT message_type, status, count(*)::int AS n FROM hub.message GROUP BY 1, 2 ORDER BY 1, 2`),
    pool.query(`SELECT stage, code, count(*)::int AS n FROM hub.dead_letter WHERE replayed_at IS NULL GROUP BY 1, 2 ORDER BY 3 DESC`),
    pool.query(`SELECT count(*)::int AS n,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY end_to_end_ms) AS p50,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY end_to_end_ms) AS p95
                FROM hub.message_latency WHERE status = 'DELIVERED' AND received_at > now() - interval '1 hour'`)
  ]);
  return [200, { byStatus: byStatus.rows, byType: byType.rows, openDeadLetters: dead.rows, latencyLastHour: latency.rows[0], fhirBaseUrl: FHIR_PUBLIC_URL }];
});

route('GET', /^\/api\/messages$/, async (_req, url) => {
  const where: string[] = [];
  const args: unknown[] = [];
  const status = url.searchParams.get('status');
  const type = url.searchParams.get('type');
  const q = url.searchParams.get('q');
  if (status) {
    args.push(status);
    where.push(`status = $${args.length}`);
  }
  if (type) {
    args.push(type);
    where.push(`message_type = $${args.length}`);
  }
  if (q) {
    args.push(`%${q}%`);
    where.push(`(control_id ILIKE $${args.length} OR raw ILIKE $${args.length})`);
  }
  args.push(Math.min(Number(url.searchParams.get('limit') ?? 100), 500));
  const rows = await pool.query(
    `SELECT id, received_at, message_type, control_id, sending_application, status, status_code, status_message, attempts, replay_of,
            EXTRACT(EPOCH FROM (delivered_at - received_at)) * 1000 AS end_to_end_ms
     FROM hub.message ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT $${args.length}`,
    args
  );
  return [200, rows.rows];
});

route('GET', /^\/api\/messages\/(\d+)$/, async (_req, _url, [id]) => {
  const m = await pool.query(`SELECT * FROM hub.message WHERE id = $1`, [id]);
  if (!m.rowCount) return [404, { error: 'not found' }];
  const [dead, replays] = await Promise.all([
    pool.query(`SELECT * FROM hub.dead_letter WHERE message_id = $1 ORDER BY id`, [id]),
    pool.query(`SELECT id, status, received_at FROM hub.message WHERE replay_of = $1 ORDER BY id`, [id])
  ]);
  return [200, { ...m.rows[0], deadLetters: dead.rows, replays: replays.rows, fhirBaseUrl: FHIR_PUBLIC_URL }];
});

route('GET', /^\/api\/dead-letters$/, async (_req, url) => {
  const open = url.searchParams.get('open') !== '0';
  const rows = await pool.query(
    `SELECT d.*, m.message_type, m.control_id FROM hub.dead_letter d JOIN hub.message m ON m.id = d.message_id
     ${open ? 'WHERE d.replayed_at IS NULL' : ''} ORDER BY d.id DESC LIMIT 200`
  );
  return [200, rows.rows];
});

route('POST', /^\/api\/messages\/(\d+)\/replay$/, async (_req, _url, [id]) => [200, await replay([Number(id)])]);

route('POST', /^\/api\/dead-letters\/replay$/, async (req) => {
  const body = await readJson(req);
  const args: unknown[] = [];
  let filter = '';
  if (typeof body.code === 'string' && body.code) {
    args.push(body.code);
    filter = `AND code = $1`;
  }
  const rows = await pool.query(`SELECT DISTINCT message_id FROM hub.dead_letter WHERE replayed_at IS NULL ${filter} ORDER BY message_id LIMIT 500`, args);
  if (!rows.rowCount) return [200, { replayed: [] }];
  return [200, await replay(rows.rows.map((r) => Number(r.message_id)))];
});

route('GET', /^\/metrics$/, async () => [200, render(await collectMetrics()), 'text/plain; version=0.0.4']);

async function replay(messageIds: number[]): Promise<unknown> {
  const res = await fetch(REPLAY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageIds }) });
  const text = await res.text();
  if (!res.ok) throw new Error(`replay channel returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function collectMetrics(): Promise<Metric[]> {
  const [received, status, dead, latency] = await Promise.all([
    pool.query(`SELECT coalesce(message_type, 'UNPARSEABLE') AS type, count(*)::int AS n FROM hub.message WHERE replay_of IS NULL GROUP BY 1`),
    pool.query(`SELECT coalesce(message_type, 'UNPARSEABLE') AS type, status, count(*)::int AS n FROM hub.message GROUP BY 1, 2`),
    pool.query(`SELECT stage, code, count(*)::int AS n FROM hub.dead_letter WHERE replayed_at IS NULL GROUP BY 1, 2`),
    pool.query(`SELECT coalesce(message_type, '') AS type,
                       percentile_cont(0.5) WITHIN GROUP (ORDER BY end_to_end_ms) / 1000 AS p50,
                       percentile_cont(0.95) WITHIN GROUP (ORDER BY end_to_end_ms) / 1000 AS p95,
                       count(*)::int AS n
                FROM hub.message_latency WHERE status = 'DELIVERED' AND received_at > now() - interval '5 minutes' GROUP BY 1`)
  ]);
  const metrics: Metric[] = [
    {
      name: 'hub_messages_received_total',
      help: 'HL7 v2 messages received from the KIS (replays excluded)',
      type: 'counter',
      samples: received.rows.map((r) => ({ labels: { type: r.type }, value: r.n }))
    },
    {
      name: 'hub_messages',
      help: 'Messages by current processing status (replays included)',
      type: 'gauge',
      samples: status.rows.map((r) => ({ labels: { type: r.type, status: r.status }, value: r.n }))
    },
    {
      name: 'hub_dead_letters_open',
      help: 'Dead letters that have not been replayed yet',
      type: 'gauge',
      samples: dead.rows.map((r) => ({ labels: { stage: r.stage, code: r.code }, value: r.n }))
    },
    {
      name: 'hub_end_to_end_latency_seconds',
      help: 'Receive-to-FHIR-commit latency of messages delivered in the last 5 minutes',
      type: 'gauge',
      samples: latency.rows.flatMap((r) => [
        { labels: { type: r.type, quantile: '0.5' }, value: Number(r.p50) },
        { labels: { type: r.type, quantile: '0.95' }, value: Number(r.p95) }
      ])
    }
  ];
  try {
    metrics.push(parseOieStatistics(await oieGet('/api/channels/statistics'), HUB_CHANNELS));
    metrics.push({ name: 'oie_up', help: 'OIE REST API reachable', type: 'gauge', samples: [{ value: 1 }] });
  } catch {
    metrics.push({ name: 'oie_up', help: 'OIE REST API reachable', type: 'gauge', samples: [{ value: 0 }] });
  }
  return metrics;
}

function oieGet(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(new URL(path, OIE_URL), {
      // OIE ships a self-signed certificate (local development only)
      rejectUnauthorized: false,
      headers: { Authorization: OIE_AUTH, 'X-Requested-With': 'OpenAPI', Accept: 'application/xml' },
      timeout: 5000
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => (res.statusCode === 200 ? resolve(body) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  for (const [method, pattern, handler] of routes) {
    const m = pattern.exec(url.pathname);
    if (!m || req.method !== method) continue;
    try {
      const [status, body, type] = await handler(req, url, m.slice(1));
      res.writeHead(status, { 'Content-Type': type ?? 'application/json', 'Cache-Control': 'no-store' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => console.log(`ops console on http://localhost:${PORT}`));
process.on('SIGTERM', () => server.close(() => pool.end().then(() => process.exit(0))));
