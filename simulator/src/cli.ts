#!/usr/bin/env node
/**
 * kis-sim — simulated KIS.
 *
 *   node src/cli.ts corpus --out ../testdata/corpus --patients 36
 *   node src/cli.ts send   --host localhost --port 6661 ../testdata/golden/adt-a01-admission.hl7
 *   node src/cli.ts replay --host localhost --port 6661 --dir ../testdata/corpus [--rate 10]
 *   node src/cli.ts load   --host localhost --port 6661 --rate 50 --seconds 60
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { MllpClient } from './mllp.ts';
import { generateCorpus } from './scenarios.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string' },
    dir: { type: 'string' },
    patients: { type: 'string', default: '36' },
    seed: { type: 'string', default: '20261117' },
    host: { type: 'string', default: process.env.MLLP_HOST ?? 'localhost' },
    port: { type: 'string', default: process.env.MLLP_PORT ?? '6661' },
    rate: { type: 'string' },
    seconds: { type: 'string', default: '60' }
  }
});

const [command, ...files] = positionals;

async function main() {
  switch (command) {
    case 'corpus':
      return corpus();
    case 'send':
      return sendFiles(files.map((f) => resolve(f)));
    case 'replay': {
      if (!values.dir) throw new Error('--dir is required');
      const dir = resolve(values.dir);
      return sendFiles(readdirSync(dir).filter((f) => f.endsWith('.hl7')).sort().map((f) => join(dir, f)));
    }
    case 'load':
      return load();
    default:
      console.error('usage: kis-sim corpus|send|replay|load (see header of src/cli.ts)');
      process.exit(2);
  }
}

function corpus() {
  if (!values.out) throw new Error('--out is required');
  const out = resolve(values.out);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const messages = generateCorpus(Number(values.patients), Number(values.seed));
  for (const m of messages) writeFileSync(join(out, `${m.name}.hl7`), m.raw);
  const byType = messages.reduce<Record<string, number>>((acc, m) => ((acc[m.type] = (acc[m.type] ?? 0) + 1), acc), {});
  console.log(`wrote ${messages.length} messages to ${out}`);
  console.table(byType);
}

async function sendFiles(paths: string[]) {
  const client = new MllpClient(values.host!, Number(values.port));
  await client.connect();
  const delay = values.rate ? 1000 / Number(values.rate) : 0;
  let ok = 0;
  for (const p of paths) {
    const started = Date.now();
    const ack = await client.send(readFileSync(p, 'utf8'));
    const ms = Date.now() - started;
    if (ack.code === 'AA' || ack.code === 'CA') ok++;
    console.log(`${ack.code.padEnd(2)} ${String(ms).padStart(4)} ms  ${p.split('/').pop()}${ack.text ? '  ' + ack.text : ''}`);
    if (delay) await new Promise((r) => setTimeout(r, Math.max(0, delay - ms)));
  }
  client.close();
  console.log(`${ok}/${paths.length} accepted`);
  if (ok !== paths.length) process.exitCode = 1;
}

/** Sustained load: replays generated messages at a fixed rate with fresh control ids. */
async function load() {
  const rate = Number(values.rate ?? 50);
  const seconds = Number(values.seconds);
  const pool = generateCorpus(Math.max(36, Math.ceil((rate * seconds) / 7)), Number(values.seed));
  // original-mode MLLP: one message in flight per connection, so use several
  const connections = Math.max(1, Math.ceil(rate / 10));
  const clients = await Promise.all(
    Array.from({ length: connections }, async () => {
      const c = new MllpClient(values.host!, Number(values.port));
      await c.connect();
      return c;
    })
  );
  const latencies: number[] = [];
  let sent = 0;
  let rejected = 0;
  const end = Date.now() + seconds * 1000;
  const perClientInterval = (1000 * connections) / rate;
  await Promise.all(
    clients.map(async (client, ci) => {
      let i = ci;
      while (Date.now() < end) {
        const tick = Date.now();
        const m = pool[i % pool.length];
        const raw = m.raw.replace(/\|SIM(\d+)\|/, (_s, n) => `|L${ci}-${sent}-${n}|`);
        const ack = await client.send(raw);
        latencies.push(Date.now() - tick);
        sent++;
        if (ack.code !== 'AA' && ack.code !== 'CA') rejected++;
        i += connections;
        await new Promise((r) => setTimeout(r, Math.max(0, perClientInterval - (Date.now() - tick))));
      }
      client.close();
    })
  );
  latencies.sort((a, b) => a - b);
  const q = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];
  const report = { targetRate: rate, seconds, sent, achievedRate: +(sent / seconds).toFixed(1), rejected, ackLatencyMs: { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: latencies.at(-1) } };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
