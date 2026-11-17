import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hub from '../build/index.js';
import { FakeFhirServer } from './fake-fhir-server.ts';
import { EVN, hl7, IN1_AOK, map, MSH, PID_MUELLER, pv1, seg } from './helpers.ts';

const a01 = (id = 'M1', ts = '20261117081500') =>
  hl7(MSH('ADT^A01^ADT_A01', id), EVN('A01', ts), PID_MUELLER, pv1(), seg('DG1', { 1: '1', 3: 'I21.0^Myokardinfarkt^I10', 5: ts, 6: 'A', 15: '1' }), IN1_AOK);
const a08 = (id: string, ts: string, extra: Record<number, string> = {}, pid = PID_MUELLER) => hl7(MSH('ADT^A08^ADT_A01', id), EVN('A08', ts), pid, pv1(extra));
const a03 = (id: string, ts: string) => hl7(MSH('ADT^A03^ADT_A03', id), EVN('A03', ts), PID_MUELLER, pv1({ 45: ts }));
const oru = (id: string) =>
  hl7(
    MSH('ORU^R01^ORU_R01', id),
    PID_MUELLER,
    pv1(),
    seg('OBR', { 1: '1', 3: 'LAB-1', 4: 'ELYT^Elektrolyte^L', 7: '20261117090000', 25: 'F' }),
    seg('OBX', { 1: '1', 2: 'NM', 3: 'NA^Natrium^L', 5: '138', 6: 'mmol/l', 11: 'F' })
  );

function send(server: FakeFhirServer, raw: string): hub.DeliveryOutcome {
  return hub.deliver(map(raw), server);
}

function counts(server: FakeFhirServer) {
  const out: Record<string, number> = {};
  for (const k of server.store.keys()) {
    const t = k.split('/')[0];
    out[t] = (out[t] ?? 0) + 1;
  }
  return out;
}

test('A01 creates the ISiK resources in one transaction with resolved references', () => {
  const s = new FakeFhirServer();
  const out = send(s, a01());
  assert.equal(out.status, 'DELIVERED', out.message);
  assert.deepEqual(counts(s), { Patient: 1, Coverage: 1, Account: 1, Encounter: 1, Condition: 1, Provenance: 1 });
  const enc = s.all('Encounter')[0];
  assert.match(enc.subject.reference, /^Patient\/\d+$/);
  assert.match(enc.diagnosis[0].condition.reference, /^Condition\/\d+$/);
  assert.equal(out.locations!.length, 6);
});

test('replaying the same message twice creates no duplicates and no new versions', () => {
  const s = new FakeFhirServer();
  send(s, a01());
  const before = JSON.stringify([...s.store.entries()].filter(([k]) => !k.startsWith('Provenance')));
  const again = send(s, a01());
  assert.equal(again.status, 'DELIVERED');
  assert.deepEqual(counts(s), { Patient: 1, Coverage: 1, Account: 1, Encounter: 1, Condition: 1, Provenance: 1 });
  const after = JSON.stringify([...s.store.entries()].filter(([k]) => !k.startsWith('Provenance')));
  assert.equal(after, before);
});

test('preflight reads bypass the server search cache', () => {
  const s = new FakeFhirServer();
  send(s, a01());
  send(s, a08('M2', '20261117120000'));
  const reads = s.requests.filter((r) => r.method === 'GET');
  assert.ok(reads.length >= 3);
  for (const r of reads) assert.equal(r.headers?.['Cache-Control'], 'no-cache', r.path);
});

test('second message for a known patient becomes a versioned PUT with If-Match', () => {
  const s = new FakeFhirServer();
  send(s, a01());
  const out = send(s, a08('M2', '20261117120000', {}, PID_MUELLER.replace('Musterstraße 12a', 'Hauptstraße 1')));
  assert.equal(out.status, 'DELIVERED', out.message);
  const patientEntry = out.bundle!.entry!.find((e: any) => e.resource.resourceType === 'Patient')!;
  assert.match(patientEntry.request!.url, /^Patient\/\d+$/);
  assert.equal(patientEntry.request!.ifMatch, 'W/"1"');
  assert.equal(s.all('Patient')[0].address[0].line[0], 'Hauptstraße 1');
  assert.equal(s.all('Patient')[0].meta?.versionId, '2');
});

test('out of order: A08 arriving before A01 is applied, the later A01 does not undo newer data', () => {
  const s = new FakeFhirServer();
  // the A08 (event 12:00, new address) overtakes the A01 (event 08:15)
  assert.equal(send(s, a08('M2', '20261117120000', {}, PID_MUELLER.replace('Musterstraße 12a', 'Hauptstraße 1'))).status, 'DELIVERED');
  const late = send(s, a01('M1', '20261117081500'));
  assert.equal(late.status, 'DELIVERED');
  assert.ok(late.issues.some((i) => i.code === 'OUT_OF_ORDER_STALE_DEMOGRAPHICS'));
  assert.equal(s.all('Patient')[0].address[0].line[0], 'Hauptstraße 1');
  assert.equal(s.all('Patient').length, 1);
  assert.equal(s.all('Encounter').length, 1);
});

test('out of order: an admit or update after the discharge keeps the encounter finished', () => {
  const s = new FakeFhirServer();
  send(s, a01('M1', '20261117081500'));
  send(s, a03('M3', '20261120093000'));
  const late = send(s, a08('M2', '20261118120000'));
  assert.equal(late.status, 'DELIVERED');
  const enc = s.all('Encounter')[0];
  assert.equal(enc.status, 'finished');
  assert.equal(enc.period.end, '2026-11-20T09:30:00+01:00');
  assert.ok(late.issues.some((i) => i.code === 'OUT_OF_ORDER_STATUS_KEPT_FINISHED'));
  // the diagnosis from the A01 survives messages that do not repeat it
  assert.equal(enc.diagnosis.length, 1);
});

test('transfer history: the previous ward stays on the encounter as completed', () => {
  const s = new FakeFhirServer();
  send(s, a01());
  const a02 = hl7(MSH('ADT^A02^ADT_A02', 'M4'), EVN('A02', '20261118100000'), PID_MUELLER, pv1({ 3: 'ITS1^01^1^KLINIKUM' }));
  assert.equal(send(s, a02).status, 'DELIVERED');
  const loc = s.all('Encounter')[0].location.map((l: any) => [l.location.identifier.value, l.status]);
  assert.deepEqual(loc.slice(0, 3), [['ITS1', 'active'], ['ITS1-01', 'active'], ['ITS1-01-1', 'active']]);
  assert.deepEqual(loc.slice(3).map((l: any) => l[1]), ['completed', 'completed', 'completed']);
});

test('lab results arriving before the admission are retried, then delivered', () => {
  const s = new FakeFhirServer();
  const early = send(s, oru('L1'));
  assert.equal(early.status, 'RETRY');
  assert.equal(early.code, 'DEPENDENCY_MISSING');
  assert.equal(s.store.size, 0);
  send(s, a01());
  const later = send(s, oru('L1'));
  assert.equal(later.status, 'DELIVERED', later.message);
  const obs = s.all('Observation')[0];
  assert.equal(obs.encounter.reference, 'Encounter/' + s.all('Encounter')[0].id);
  // ORU did not create a second patient
  assert.equal(s.all('Patient').length, 1);
});

test('A40 merge retires the old patient and moves all its references in one transaction', () => {
  const s = new FakeFhirServer();
  // the duplicate record 4700 with its own admission and lab result
  const dupPid = PID_MUELLER.replace('4711^^^KLINIKUM^PI~A123456780^^^GKV^KVZ10', '4700^^^KLINIKUM^PI');
  const dupVisit = pv1({ 19: 'F2026000999' });
  assert.equal(send(s, hl7(MSH('ADT^A01^ADT_A01', 'D1'), EVN('A01', '20261117070000'), dupPid, dupVisit)).status, 'DELIVERED');
  const dupLab = hl7(MSH('ORU^R01^ORU_R01', 'D2'), dupPid, dupVisit, seg('OBR', { 1: '1', 3: 'LAB-9', 4: 'ELYT^^L' }), seg('OBX', { 1: '1', 2: 'NM', 3: 'K^Kalium^L', 5: '4.1', 6: 'mmol/l' }));
  assert.equal(send(s, dupLab).status, 'DELIVERED');
  // the surviving record 4711
  send(s, a01());
  const [retired] = s.all('Patient').filter((p) => p.identifier.some((i: any) => i.value === '4700'));
  const retiredRef = 'Patient/' + retired.id;

  const merge = hl7(MSH('ADT^A40^ADT_A39', 'MRG1'), EVN('A40', '20261118090000'), PID_MUELLER, seg('MRG', { 1: '4700^^^KLINIKUM^PI' }));
  const out = send(s, merge);
  assert.equal(out.status, 'DELIVERED', out.message);
  // Encounter, Account, Observation and DiagnosticReport of the duplicate record
  assert.ok(out.issues.some((i) => i.code === 'MERGE_PLANNED' && i.message.includes('4 reference(s) moved')), JSON.stringify(out.issues));

  const survivor = s.all('Patient').find((p) => p.active !== false)!;
  const retiredNow = s.read(retiredRef)!;
  assert.equal(retiredNow.active, false);
  assert.deepEqual(retiredNow.link, [{ other: { reference: 'Patient/' + survivor.id }, type: 'replaced-by' }]);
  assert.deepEqual(survivor.link, [{ other: { reference: retiredRef }, type: 'replaces' }]);
  assert.ok(survivor.identifier.some((i: any) => i.use === 'old' && i.value === '4700'));
  for (const type of ['Encounter', 'Account', 'Observation', 'DiagnosticReport']) {
    for (const r of s.all(type)) assert.notEqual(r.subject.reference ?? r.subject[0].reference, retiredRef, type + ' still points at the retired patient');
  }

  // replaying the merge is harmless
  const replay = send(s, merge);
  assert.equal(replay.status, 'DELIVERED');
  assert.ok(replay.issues.some((i) => i.code === 'MERGE_REPLAYED'));

  // a late message that still uses the retired number lands on the survivor without overwriting it
  const late = send(s, hl7(MSH('ORU^R01^ORU_R01', 'D3'), dupPid, seg('OBR', { 1: '1', 3: 'LAB-10', 4: 'ELYT^^L' }), seg('OBX', { 1: '1', 2: 'NM', 3: 'NA^^L', 5: '140', 6: 'mmol/l' })));
  assert.equal(late.status, 'DELIVERED', late.message);
  const lab10 = s.all('Observation').find((o) => o.identifier[0].value.startsWith('LAB-10'))!;
  assert.equal(lab10.subject.reference, 'Patient/' + survivor.id);
  assert.equal(s.all('Patient').length, 2);

  // a later ADT for the survivor must keep the merge alias (regression seen end-to-end)
  const a02 = hl7(MSH('ADT^A02^ADT_A02', 'MRG2'), EVN('A02', '20261118120000'), PID_MUELLER, pv1({ 3: 'ITS1^01^1^KLINIKUM' }));
  const after = send(s, a02);
  assert.equal(after.status, 'DELIVERED', after.message);
  const survivorNow = s.read('Patient/' + survivor.id)!;
  assert.ok(survivorNow.identifier.some((i: any) => i.use === 'old' && i.value === '4700'), JSON.stringify(survivorNow.identifier));
  assert.ok(survivorNow.link?.length, 'link replaces is kept');
});

test('MDM^T10 supersedes the replaced document', () => {
  const s = new FakeFhirServer();
  send(s, a01());
  const pdf = Buffer.from('%PDF-1.4 test').toString('base64');
  const doc = (event: string, id: string, number: string, parent = '') =>
    hl7(
      MSH(`MDM^${event}^MDM_T02`, id),
      PID_MUELLER,
      pv1(),
      seg('TXA', { 1: '1', 2: 'ENTL^Entlassbrief^L', 3: 'AP', 4: '20261120105500', 12: number, 13: parent, 17: 'AU', 19: 'AV' }),
      seg('OBX', { 1: '1', 2: 'ED', 5: `^AP^PDF^Base64^${pdf}` })
    );
  assert.equal(send(s, doc('T02', 'X1', 'DOC-1')).status, 'DELIVERED');
  const out = send(s, doc('T10', 'X2', 'DOC-2', 'DOC-1'));
  assert.equal(out.status, 'DELIVERED', out.message);
  const docs = s.all('DocumentReference');
  assert.deepEqual(docs.map((d) => [d.masterIdentifier.value, d.status]).sort(), [['DOC-1', 'superseded'], ['DOC-2', 'current']]);
  assert.equal(s.all('Binary').length, 2);
});

test('server errors are retried, validation errors are dead-lettered', () => {
  const s = new FakeFhirServer();
  s.down = true;
  assert.deepEqual(pick(send(s, a01())), ['RETRY', 'SERVER_UNAVAILABLE']);
  s.down = false;

  s.failNext = { status: 503, body: '' };
  assert.deepEqual(pick(send(s, a01())), ['RETRY', 'SERVER_UNAVAILABLE']);

  s.failNext = { status: 409, body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'conflict', diagnostics: 'version conflict' }] }) };
  assert.deepEqual(pick(send(s, a01())), ['RETRY', 'VERSION_CONFLICT']);

  const invalid = {
    resourceType: 'OperationOutcome',
    issue: [{ severity: 'error', code: 'processing', diagnostics: 'Patient.name: minimum required = 1, but only found 0', expression: ['Patient'] }]
  };
  s.failNext = { status: 412, body: JSON.stringify(invalid) };
  const failed = send(s, a01());
  assert.deepEqual(pick(failed), ['FAILED', 'VALIDATION_FAILED']);
  assert.deepEqual(failed.serverIssues, ['Patient.name: minimum required = 1, but only found 0 @ Patient']);

  s.failNext = { status: 412, body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'duplicate', diagnostics: 'HAPI-0958: Failed to process conditional update. Multiple resources match this search' }] }) };
  assert.deepEqual(pick(send(s, a01())), ['FAILED', 'AMBIGUOUS_MATCH']);

  // seen on HAPI 8.12 under CPU pressure: a validator timeout reported as a 422 validation error
  s.failNext = { status: 422, body: JSON.stringify({ resourceType: 'OperationOutcome', issue: [{ severity: 'error', code: 'processing', diagnostics: "Exception evaluating regex '[^\\s]+(\\s[^\\s]+)*' on type code: Regex evaluation timed out after " }] }) };
  assert.deepEqual(pick(send(s, a01())), ['RETRY', 'SERVER_BUSY']);
});

function pick(o: hub.DeliveryOutcome) {
  return [o.status, o.code];
}
