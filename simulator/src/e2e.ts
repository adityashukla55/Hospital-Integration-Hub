/**
 * End-to-end check against the running stack (make up):
 *
 *   node src/e2e.ts
 *
 *  1. sends the generated corpus over MLLP and waits until every message is settled
 *  2. expects every corpus message DELIVERED (no dead letters) and checks FHIR resource counts
 *  3. sends the corpus again: FHIR resource counts must not change (idempotency on a real server)
 *  4. replays a delivered message through the replay API: still no new resources
 *  5. sends the negative golden cases and expects the right dead-letter codes / IGNORED
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MllpClient } from './mllp.ts';

const repo = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OPS = process.env.OPS_URL ?? 'http://localhost:8088';
const FHIR = process.env.FHIR_URL ?? 'http://localhost:8080/fhir';
const host = process.env.MLLP_HOST ?? 'localhost';
const port = Number(process.env.MLLP_PORT ?? 6661);
const TYPES = ['Patient', 'Encounter', 'Account', 'Coverage', 'Condition', 'Observation', 'DiagnosticReport', 'ServiceRequest', 'DocumentReference', 'Binary', 'Provenance'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (url: string, init?: RequestInit): Promise<any> => {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
};

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of TYPES) out[t] = (await json(`${FHIR}/${t}?_summary=count`)).total;
  return out;
}

async function settled(sinceId: number, timeoutMs = 15 * 60000): Promise<Array<{ id: number; status: string; status_code: string; message_type: string; control_id: string; end_to_end_ms: number }>> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await json(`${OPS}/api/messages?limit=500`)).filter((m: { id: number | string }) => Number(m.id) > sinceId);
    const open = rows.filter((m: { status: string }) => ['RECEIVED', 'MAPPED', 'RETRYING'].includes(m.status));
    if (!open.length && rows.length) return rows;
    if (Date.now() > end) throw new Error(`${open.length} messages not settled: ${JSON.stringify(open.slice(0, 5))}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function lastId(): Promise<number> {
  const rows = await json(`${OPS}/api/messages?limit=1`);
  // bigserial ids arrive as strings from node-postgres
  return rows.length ? Number(rows[0].id) : 0;
}

async function send(files: string[]): Promise<number> {
  const c = new MllpClient(host, port);
  await c.connect();
  const started = Date.now();
  for (const f of files) {
    const ack = await c.send(readFileSync(f, 'utf8'));
    if (ack.code !== 'AA') throw new Error(`${f}: ACK ${ack.code} ${ack.text}`);
  }
  c.close();
  return Date.now() - started;
}

function check(cond: unknown, msg: string) {
  if (!cond) throw new Error('FAILED: ' + msg);
  console.log('ok   ' + msg);
}

const percentile = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
};

async function main() {
  const corpusDir = join(repo, 'testdata', 'corpus');
  const corpus = readdirSync(corpusDir).filter((f) => f.endsWith('.hl7')).sort().map((f) => join(corpusDir, f));
  const report: Record<string, unknown> = { at: new Date().toISOString(), corpus: corpus.length };

  const quick = process.argv.includes('--quick');
  let baseline = await counts();
  let replayTarget: number;

  if (!quick) {
    // 1 + 2: the corpus, first pass
    const before = baseline;
    const since = await lastId();
    const t0 = Date.now();
    const sendMs = await send(corpus);
    const rows = await settled(since);
    const wallMs = Date.now() - t0;
    const delivered = rows.filter((r) => r.status === 'DELIVERED');
    const failed = rows.filter((r) => r.status === 'FAILED');
    for (const f of failed.slice(0, 10)) console.log('     dead letter:', f.id, f.message_type, f.status_code);
    check(rows.length === corpus.length, `${corpus.length} corpus messages stored`);
    check(failed.length === 0, `no dead letters for the corpus (${failed.length})`);
    check(delivered.length === corpus.length, `${delivered.length}/${corpus.length} delivered to HAPI with ISiK validation on`);
    const after = await counts();
    const created = Object.fromEntries(TYPES.map((t) => [t, after[t] - before[t]]));
    console.log('     resources created:', JSON.stringify(created));
    const latencies = delivered.map((r) => Number(r.end_to_end_ms));
    report.firstPass = {
      sendMs,
      wallMs,
      throughputPerSecond: +(corpus.length / (wallMs / 1000)).toFixed(1),
      e2eMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: percentile(latencies, 1) },
      created
    };
    check(created.Provenance === corpus.length, 'one Provenance per message');

    // 3: idempotency on a real server
    const since2 = await lastId();
    await send(corpus);
    const again = await settled(since2);
    check(again.every((r) => r.status === 'DELIVERED'), 're-sent corpus delivered again');
    const afterResend = await counts();
    check(TYPES.every((t) => afterResend[t] === after[t]), `re-sending all ${corpus.length} messages created no new resources`);
    baseline = afterResend;
    replayTarget = delivered[0].id;
  } else {
    replayTarget = (await json(`${OPS}/api/messages?status=DELIVERED&limit=1`))[0].id;
  }

  // 4: replay API
  const sinceReplay = await lastId();
  const replay = await json(`${OPS}/api/messages/${replayTarget}/replay`, { method: 'POST' });
  check(replay.replayed?.[0]?.replayId, `replay API accepted message ${replayTarget}`);
  const replayed = await settled(sinceReplay);
  check(
    replayed.length === 1 && replayed[0].status === 'DELIVERED',
    `replayed message delivered (${JSON.stringify(replayed.map((r) => [r.id, r.status, r.status_code]))})`
  );
  const afterReplayApi = await counts();
  check(TYPES.every((t) => afterReplayApi[t] === baseline[t]), 'replay created no new resources');

  // 5: negative cases
  const since = await lastId();
  const golden = (n: string) => join(repo, 'testdata', 'golden', `${n}.hl7`);
  await send([golden('oru-r01-unmapped-code'), golden('adt-a31-ignored'), golden('parse-error-not-hl7')]);
  const neg = await settled(since);
  const byControl = Object.fromEntries(neg.map((r) => [r.control_id ?? '', r]));
  check(byControl['G0009']?.status_code === 'TERMINOLOGY_UNMAPPED', 'unmapped lab code dead-lettered as TERMINOLOGY_UNMAPPED');
  check(byControl['G0007']?.status === 'IGNORED', 'ADT^A31 ignored');
  check(neg.some((r) => r.status_code === 'PARSE_ERROR'), 'non-HL7 payload dead-lettered as PARSE_ERROR');
  const summary = await json(`${OPS}/api/summary`);
  report.openDeadLetters = summary.openDeadLetters;

  mkdirSync(join(repo, 'reports'), { recursive: true });
  writeFileSync(join(repo, 'reports', 'e2e.json'), JSON.stringify(report, null, 2));
  console.log('\n' + JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
