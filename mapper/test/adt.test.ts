import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hub from '../build/index.js';
import { entries, EVN, expectMappingError, hl7, IN1_AOK, map, MSH, PID_MUELLER, pv1, resources, seg, terminology, NOW } from './helpers.ts';

const A01 = hl7(
  MSH('ADT^A01^ADT_A01', 'MSG0001'),
  EVN('A01', '20261117081500'),
  PID_MUELLER,
  pv1(),
  seg('PV2', { 3: '0101' }),
  seg('DG1', { 1: '1', 3: 'I21.0^Akuter transmuraler Myokardinfarkt der Vorderwand^I10^^^^2026', 5: '20261117082000', 6: 'A', 15: '1' }),
  seg('ZDG', { 1: '1', 2: 'G' }),
  seg('DG1', { 1: '2', 3: 'M17.1^Sonstige primäre Gonarthrose^I10', 5: '20261117082000', 6: 'W', 15: '2' }),
  seg('ZDG', { 1: '2', 2: 'V', 3: 'R' }),
  IN1_AOK
);

test('A01 produces one transaction with the ISiK resources and a Provenance', () => {
  const r = map(A01);
  assert.equal(r.bundle.type, 'transaction');
  const types = r.bundle.entry!.map((e: any) => e.resource.resourceType).sort();
  assert.deepEqual(types, ['Account', 'Condition', 'Condition', 'Coverage', 'Encounter', 'Patient', 'Provenance']);
  for (const e of r.bundle.entry!) assert.match(e.fullUrl!, /^urn:uuid:/);
});

test('Patient: identifiers, German name parts, gender, address, telecom', () => {
  const [p] = resources(map(A01), 'Patient');
  assert.deepEqual(p.meta.profile, [hub.PROFILE.patient]);
  const pn = p.identifier.find((i: any) => i.type.coding[0].code === 'MR');
  assert.equal(pn.value, '4711');
  assert.equal(pn.system, 'https://fhir.klinikum-musterstadt.example/sid/patientennummer');
  const kvnr = p.identifier.find((i: any) => i.system === 'http://fhir.de/sid/gkv/kvid-10');
  assert.equal(kvnr.value, 'A123456780');
  assert.equal(kvnr.type.coding[0].code, 'KVZ10');

  const official = p.name.find((n: any) => n.use === 'official');
  assert.equal(official.family, 'von Müller');
  assert.deepEqual(official._family.extension.map((e: any) => [e.url.split('/').pop(), e.valueString]), [
    ['humanname-own-prefix', 'von'],
    ['humanname-own-name', 'Müller']
  ]);
  assert.deepEqual(official.given, ['Anna', 'Maria']);
  assert.deepEqual(official.prefix, ['Dr.']);
  assert.equal(official._prefix[0].extension[0].valueCode, 'AC');
  const maiden = p.name.find((n: any) => n.use === 'maiden');
  assert.equal(maiden.family, 'Schmidt');
  assert.equal(maiden.given, undefined);

  assert.equal(p.gender, 'female');
  assert.equal(p.birthDate, '1975-03-12');
  assert.equal(p.address[0].type, 'both');
  assert.equal(p.address[0].country, 'DE');
  assert.deepEqual(p.address[0]._line[0].extension.map((e: any) => e.valueString), ['Musterstraße', '12a']);
  assert.deepEqual(p.telecom, [
    { system: 'phone', value: '+49 30 1234567', use: 'home' },
    { system: 'email', value: 'anna.mueller@example.org', use: 'home' }
  ]);
});

test('Patient is a conditional update on the Patientennummer that ignores retired (merged) records', () => {
  const [e] = entries(map(A01), 'Patient');
  assert.equal(e.request.method, 'PUT');
  assert.equal(
    e.request.url,
    'Patient?identifier=' + encodeURIComponent('https://fhir.klinikum-musterstadt.example/sid/patientennummer|4711') + '&active:not=false'
  );
});

test('divers gender carries the gender-amtlich-de extension (isik-pat-1)', () => {
  const raw = A01.replace('|19750312|F|', '|19750312|D|');
  const [p] = resources(map(raw), 'Patient');
  assert.equal(p.gender, 'other');
  assert.equal(p._gender.extension[0].valueCoding.code, 'D');
});

test('missing birth date uses data-absent-reason instead of failing', () => {
  const raw = A01.replace('|19750312|F|', '||F|');
  const r = map(raw);
  const [p] = resources(r, 'Patient');
  assert.equal(p.birthDate, undefined);
  assert.equal(p._birthDate.extension[0].valueCode, 'unknown');
  assert.ok(r.issues.some((i) => i.code === 'MISSING_BIRTHDATE'));
});

test('Encounter: department contact with class, period, Fachabteilung, locations and §301 codes', () => {
  const r = map(A01);
  const [enc] = resources(r, 'Encounter');
  assert.deepEqual(enc.meta.profile, [hub.PROFILE.encounter]);
  assert.equal(enc.status, 'in-progress');
  assert.equal(enc.class.code, 'IMP');
  assert.equal(enc.type[0].coding[0].code, 'abteilungskontakt');
  assert.equal(enc.identifier[0].value, 'F2026000123');
  assert.equal(enc.identifier[0].type.coding[0].code, 'VN');
  assert.equal(enc.period.start, '2026-11-17T08:00:00+01:00');
  assert.equal(enc.period.end, undefined);
  assert.equal(enc.serviceType.coding[0].code, '0100');
  assert.equal(enc.hospitalization.admitSource.coding[0].code, 'E');
  assert.deepEqual(enc.location.map((l: any) => [l.physicalType.coding[0].code, l.location.identifier.value, l.status]), [
    ['wa', 'STA3', 'active'],
    ['ro', 'STA3-304', 'active'],
    ['bd', 'STA3-304-2', 'active']
  ]);
  assert.equal(enc.extension[0].url, 'http://fhir.de/StructureDefinition/Aufnahmegrund');
  assert.deepEqual(enc.extension[0].extension.map((e: any) => e.valueCoding.code), ['01', '0', '1']);
  assert.equal(enc.serviceProvider.identifier.value, '261101015');
  assert.deepEqual(r.hints.statefulEncounters.map((h) => h.event), ['A01']);
});

test('Encounter references its diagnoses with Diagnosetyp and main-diagnosis subtype', () => {
  const r = map(A01);
  const [enc] = resources(r, 'Encounter');
  const conditionUrls = entries(r, 'Condition').map((e) => e.fullUrl);
  assert.deepEqual(enc.diagnosis.map((d: any) => d.condition.reference), conditionUrls);
  assert.deepEqual(enc.diagnosis[0].use.coding.map((c: any) => c.code), ['referral-diagnosis']);
  assert.deepEqual(enc.diagnosis[1].use.coding.map((c: any) => c.code), ['treatment-diagnosis']);
  assert.equal(enc.diagnosis[0].rank, 1);
});

test('Condition: ICD-10-GM with version, Diagnosesicherheit and Seitenlokalisation from ZDG', () => {
  const [c1, c2] = resources(map(A01), 'Condition');
  assert.deepEqual(c1.meta.profile, [hub.PROFILE.condition]);
  assert.equal(c1.code.coding[0].system, 'http://fhir.de/CodeSystem/bfarm/icd-10-gm');
  assert.equal(c1.code.coding[0].version, '2026');
  assert.equal(c1.code.coding[0].code, 'I21.0');
  assert.equal(c1.verificationStatus.coding[0].code, 'confirmed');
  assert.equal(c1.recordedDate, '2026-11-17T08:20:00+01:00');
  const ext2 = Object.fromEntries(c2.code.coding[0].extension.map((e: any) => [e.url.split('/').pop(), e.valueCoding.code]));
  assert.deepEqual(ext2, { seitenlokalisation: 'R', 'icd-10-gm-diagnosesicherheit': 'V' });
  assert.equal(c2.verificationStatus.coding[0].code, 'provisional');
  assert.ok(c1.encounter.reference.startsWith('urn:uuid:'));
});

test('Coverage (GKV) and Account (Abrechnungsfall)', () => {
  const r = map(A01);
  const [cov] = resources(r, 'Coverage');
  assert.deepEqual(cov.meta.profile, [hub.PROFILE.coverageGkv]);
  assert.equal(cov.type.coding[0].code, 'GKV');
  assert.equal(cov.payor[0].identifier.system, 'http://fhir.de/sid/arge-ik/iknr');
  assert.equal(cov.payor[0].identifier.value, '108018007');
  assert.equal(cov.payor[0].display, 'Muster-Krankenkasse');
  assert.equal(cov.subscriber.identifier.value, 'A123456780');
  const [acc] = resources(r, 'Account');
  assert.equal(acc.identifier[0].type.coding[0].code, 'AN');
  assert.equal(acc.identifier[0].value, 'F2026000123');
  assert.equal(acc.coverage[0].coverage.reference, entries(r, 'Coverage')[0].fullUrl);
});

test('A03 finishes the encounter and maps the Entlassungsgrund', () => {
  const raw = hl7(MSH('ADT^A03^ADT_A03', 'MSG0002'), EVN('A03', '20261120100000'), PID_MUELLER, pv1({ 36: '019', 45: '20261120093000' }));
  const [enc] = resources(map(raw), 'Encounter');
  assert.equal(enc.status, 'finished');
  assert.equal(enc.period.end, '2026-11-20T09:30:00+01:00');
  assert.ok(enc.location.every((l: any) => l.status === 'completed'));
  const ext = enc.hospitalization.dischargeDisposition.extension[0];
  assert.deepEqual(ext.extension.map((e: any) => e.valueCoding.code), ['01', '9']);
});

test('A03 without discharge time falls back to the event time (ISiK-enc-2)', () => {
  const raw = hl7(MSH('ADT^A03^ADT_A03', 'MSG0003'), EVN('A03', '20261120100000'), PID_MUELLER, pv1());
  const r = map(raw);
  const [enc] = resources(r, 'Encounter');
  assert.equal(enc.period.end, '2026-11-20T10:00:00+01:00');
  assert.ok(r.issues.some((i) => i.code === 'DERIVED_DISCHARGE_TIME'));
});

test('A02 transfer keeps the prior location as completed', () => {
  const raw = hl7(MSH('ADT^A02^ADT_A02', 'MSG0004'), EVN('A02', '20261118120000'), PID_MUELLER, pv1({ 3: 'ITS1^01^1^KLINIKUM', 6: 'STA3^304^2^KLINIKUM' }));
  const [enc] = resources(map(raw), 'Encounter');
  assert.deepEqual(enc.location.map((l: any) => [l.location.identifier.value, l.status]), [
    ['ITS1', 'active'],
    ['ITS1-01', 'active'],
    ['ITS1-01-1', 'active'],
    ['STA3', 'completed'],
    ['STA3-304', 'completed'],
    ['STA3-304-2', 'completed']
  ]);
});

test('A08 without a visit only updates the patient', () => {
  const raw = hl7(MSH('ADT^A08^ADT_A01', 'MSG0005'), EVN('A08', '20261118120000'), PID_MUELLER, seg('PV1', { 1: '1', 2: 'N' }));
  const r = map(raw);
  assert.deepEqual(r.bundle.entry!.map((e: any) => e.resource.resourceType), ['Patient', 'Provenance']);
  assert.ok(r.hints.statefulPatient);
});

test('A40 merge: survivor keeps the retired number as an old identifier', () => {
  const raw = hl7(MSH('ADT^A40^ADT_A39', 'MSG0006'), EVN('A40', '20261118120000'), PID_MUELLER, seg('MRG', { 1: '4700^^^KLINIKUM^PI' }));
  const r = map(raw);
  const [p] = resources(r, 'Patient');
  assert.ok(p.identifier.some((i: any) => i.use === 'old' && i.value === '4700'));
  assert.equal(r.hints.merge!.retiredIdentifier.value, '4700');
  assert.equal(r.hints.merge!.survivorIdentifier.value, '4711');
});

test('Provenance links every resource to the source message and is idempotent', () => {
  const r = map(A01);
  const [prov] = resources(r, 'Provenance');
  const provEntry = entries(r, 'Provenance')[0];
  assert.equal(provEntry.request.method, 'PUT');
  assert.equal(provEntry.request.url, 'Provenance/' + hub.deterministicId('hl7v2', 'KLINIKUM|KIS|MSG0001'));
  const others = r.bundle.entry!.filter((e: any) => e.resource.resourceType !== 'Provenance').map((e: any) => e.fullUrl);
  assert.deepEqual(prov.target.map((t: any) => t.reference), others);
  assert.equal(prov.occurredDateTime, '2026-11-17T08:15:00+01:00');
  assert.equal(prov.recorded, '2026-11-17T09:00:00Z');
  assert.equal(prov.entity[0].what.identifier.value, 'KLINIKUM|KIS|MSG0001');
});

test('same message maps to byte-identical output (stable golden files, idempotent replays)', () => {
  assert.equal(JSON.stringify(map(A01).bundle), JSON.stringify(map(A01).bundle));
});

test('errors name the failing field', () => {
  const noPid = A01.replace('4711^^^KLINIKUM^PI~', '');
  const e1 = expectMappingError(() => map(noPid));
  assert.equal(e1.code, 'MISSING_REQUIRED_FIELD');
  assert.equal(e1.location, 'PID-3');

  const badClass = A01.replace('PV1|1|I|', 'PV1|1|Q|');
  assert.equal(expectMappingError(() => map(badClass)).location, 'PV1-2');

  const noVisit = A01.replace('F2026000123', '');
  assert.equal(expectMappingError(() => map(noVisit)).location, 'PV1-19');

  const badIcd = A01.replace('I21.0^', 'XYZ^');
  assert.equal(expectMappingError(() => map(badIcd)).code, 'INVALID_VALUE');
});

test('unsupported events are ignored, not failed', () => {
  const out = hub.mapMessage(hl7(MSH('ADT^A31^ADT_A05', 'MSG0007'), PID_MUELLER), { terminology: terminology(), now: NOW });
  assert.equal(out.status, 'IGNORED');
});

test('transform() never throws and reports the error code', () => {
  const out = hub.transform('garbage', { terminology: terminology(), now: NOW }) as any;
  assert.equal(out.status, 'ERROR');
  assert.equal(out.code, 'PARSE_ERROR');
});
