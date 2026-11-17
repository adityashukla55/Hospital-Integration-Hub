import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { kvnrCheckDigit, makeKvnr, rng } from '../src/synthetic.ts';
import { generateCorpus } from '../src/scenarios.ts';
import { MllpClient } from '../src/mllp.ts';
import { parseAck, seg } from '../src/hl7.ts';

test('KVNR check digit (letter as alphabet position, weights 1-2-1-2, digit sums, mod 10)', () => {
  assert.equal(kvnrCheckDigit('A', '12345678'), 0);
  const r = rng(1);
  for (let i = 0; i < 100; i++) {
    const k = makeKvnr(r);
    assert.match(k, /^[A-Z]\d{9}$/);
    assert.equal(kvnrCheckDigit(k[0], k.slice(1, 9)), Number(k[9]));
  }
});

test('corpus is deterministic for a seed and has 200+ messages of all supported types', () => {
  const a = generateCorpus(36);
  const b = generateCorpus(36);
  assert.deepEqual(a.map((m) => m.raw), b.map((m) => m.raw));
  assert.ok(a.length >= 200);
  const types = new Set(a.map((m) => m.type));
  for (const t of ['ADT^A01', 'ADT^A02', 'ADT^A03', 'ADT^A04', 'ADT^A08', 'ADT^A40', 'OML^O21', 'ORU^R01', 'MDM^T02']) assert.ok(types.has(t), t);
  // messages are in sending order and control ids are unique
  assert.equal(new Set(a.map((m) => /\|(SIM\d+)\|/.exec(m.raw)![1])).size, a.length);
  for (let i = 1; i < a.length; i++) assert.ok(a[i].at >= a[i - 1].at);
});

test('seg() places fields by number, including MSH numbering', () => {
  assert.equal(seg('PV1', { 2: 'I', 4: 'E' }), 'PV1||I||E');
  assert.equal(seg('MSH', { 3: 'KIS', 9: 'ADT^A01' }), 'MSH|^~\\&|KIS||||||ADT^A01');
});

test('MLLP client frames messages and reads ACKs', async () => {
  const server = net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf(0x1c);
      if (end < 0) return;
      const msg = buf.subarray(1, end).toString();
      buf = buf.subarray(end + 2);
      const id = msg.split('\r')[0].split('|')[9];
      socket.write(Buffer.concat([Buffer.from([0x0b]), Buffer.from(`MSH|^~\\&|HUB||KIS||20261117||ACK|${id}|P|2.5\rMSA|AA|${id}`), Buffer.from([0x1c, 0x0d])]));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as net.AddressInfo).port;
  const client = new MllpClient('127.0.0.1', port, 2000);
  await client.connect();
  const ack = await client.send(seg('MSH', { 3: 'KIS', 9: 'ADT^A01', 10: 'C42', 11: 'P', 12: '2.5' }));
  assert.equal(ack.code, 'AA');
  assert.equal(ack.controlId, 'C42');
  client.close();
  server.close();
});

test('parseAck reads MSA', () => {
  assert.deepEqual(parseAck('MSH|^~\\&|X\rMSA|AE|C1|bad'), { code: 'AE', controlId: 'C1', text: 'bad' });
});
