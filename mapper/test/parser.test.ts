import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hub from '../build/index.js';
import { expectMappingError, hl7, MSH, seg } from './helpers.ts';

test('MSH field numbering: MSH-1 is the separator, MSH-9 the message type', () => {
  const msg = hub.parseHl7(hl7(MSH('ADT^A01^ADT_A01', 'C1'), seg('PID', { 3: '1' })));
  const msh = msg.segments[0];
  assert.equal(msh.get(1), '|');
  assert.equal(msh.get(2), '^~\\&');
  assert.equal(msh.get(3), 'KIS');
  assert.equal(msg.header.messageCode, 'ADT');
  assert.equal(msg.header.triggerEvent, 'A01');
  assert.equal(msg.header.structure, 'ADT_A01');
  assert.equal(msg.header.controlId, 'C1');
});

test('repetitions, components, subcomponents and escapes', () => {
  const msg = hub.parseHl7(hl7(MSH('ADT^A01', 'C1'), 'PID|1||A~B^^^AUTH&1.2.3&ISO||Meier\\S\\Schulze^Hans\\T\\Peter||||||Zeile1\\.br\\Zeile2\\F\\x\\X4D\\\\XC3BC\\'));
  const pid = msg.segment('PID')!;
  assert.deepEqual(pid.reps(3).map((r) => r.c(1)), ['A', 'B']);
  assert.equal(pid.get(3, 4, 2, 2), '1.2.3');
  assert.equal(pid.get(5, 1), 'Meier^Schulze');
  assert.equal(pid.get(5, 2), 'Hans&Peter');
  assert.equal(pid.get(11), 'Zeile1\nZeile2|xMü');
});

test('accepts \\n terminators and MLLP framing', () => {
  const raw = '\u000b' + [MSH('ORU^R01', 'C2'), 'PID|1'].join('\n') + '\u001c\r';
  const msg = hub.parseHl7(raw);
  assert.equal(msg.segments.length, 2);
  assert.equal(msg.header.controlId, 'C2');
});

test('rejects messages that are not HL7 v2', () => {
  assert.equal(expectMappingError(() => hub.parseHl7('hello')).code, 'PARSE_ERROR');
  assert.equal(expectMappingError(() => hub.parseHl7('MSH|^~|x')).code, 'PARSE_ERROR');
  assert.equal(expectMappingError(() => hub.parseHl7(hl7(MSH('ADT^A01', 'C3'), 'pid|1'))).code, 'PARSE_ERROR');
});

test('timestamps get a Europe/Berlin offset with daylight-saving time', () => {
  const tz = hub.CENTRAL_EUROPE;
  assert.equal(hub.toFhirDateTime('20260115083000', tz), '2026-01-15T08:30:00+01:00');
  assert.equal(hub.toFhirDateTime('20260715083000', tz), '2026-07-15T08:30:00+02:00');
  // EU switch dates 2026: 29 March and 25 October
  assert.equal(hub.toFhirDateTime('202603290159', tz), '2026-03-29T01:59:00+01:00');
  assert.equal(hub.toFhirDateTime('202603290300', tz), '2026-03-29T03:00:00+02:00');
  assert.equal(hub.toFhirDateTime('202610250330', tz), '2026-10-25T03:30:00+01:00');
  // explicit offsets win, date-only stays date-only
  assert.equal(hub.toFhirDateTime('20260715083000-0500', tz), '2026-07-15T08:30:00-05:00');
  assert.equal(hub.toFhirDateTime('19750312', tz), '1975-03-12');
  assert.equal(hub.toFhirDate('197503', ), '1975-03');
  assert.equal(hub.toFhirInstant('20260715', tz), undefined);
  assert.equal(hub.toFhirDateTime('20261340', tz), undefined);
});

test('FHIR dateTime to epoch respects offsets', () => {
  assert.equal(hub.fhirDateTimeToEpoch('2026-07-15T08:30:00+02:00'), Date.UTC(2026, 6, 15, 6, 30));
  assert.equal(hub.fhirDateTimeToEpoch('2026-07-15T06:30:00Z'), Date.UTC(2026, 6, 15, 6, 30));
});

test('deterministic ids are stable, distinct and valid FHIR ids', () => {
  const a = hub.deterministicId('hl7v2', 'KLINIKUM|KIS|1');
  assert.equal(a, hub.deterministicId('hl7v2', 'KLINIKUM|KIS|1'));
  assert.notEqual(a, hub.deterministicId('hl7v2', 'KLINIKUM|KIS|2'));
  assert.match(a, /^[A-Za-z0-9\-.]{1,64}$/);
  assert.match(hub.deterministicUuid('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const seen = new Set<string>();
  for (let i = 0; i < 20000; i++) seen.add(hub.hash128('msg-' + i));
  assert.equal(seen.size, 20000);
});
