import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hub from '../build/index.js';
import { entries, expectMappingError, hl7, map, MSH, PID_MUELLER, pv1, resources, seg } from './helpers.ts';

const ORU = hl7(
  MSH('ORU^R01^ORU_R01', 'LAB0001', '20261117103000'),
  PID_MUELLER,
  pv1(),
  seg('ORC', { 1: 'RE', 2: 'ANF-778', 3: 'LAB-2026-5512' }),
  seg('OBR', { 1: '1', 2: 'ANF-778', 3: 'LAB-2026-5512', 4: 'ELYT^Elektrolyte^L', 7: '20261117090000', 22: '20261117102500', 25: 'F' }),
  seg('OBX', { 1: '1', 2: 'NM', 3: 'NA^Natrium^L', 5: '138', 6: 'mmol/l', 7: '135-145', 8: 'N', 11: 'F' }),
  seg('OBX', { 1: '2', 2: 'NM', 3: 'K^Kalium^L', 5: '5,9', 6: 'mmol/l', 7: '3.5-5.1', 8: 'H', 11: 'F' }),
  seg('NTE', { 1: '1', 3: 'Probe leicht hämolytisch' }),
  seg('OBX', { 1: '3', 2: 'SN', 3: 'CRP^C-reaktives Protein^L', 5: '<^0.5', 6: 'mg/dl', 7: '<0.5', 11: 'F' }),
  seg('OBX', { 1: '4', 2: 'NM', 3: '2160-0^Creatinine^LN', 5: '1.1', 6: 'mg/dL^mg/dL^UCUM', 11: 'P' }),
  seg('SPM', { 1: '1', 2: 'P-1&KIS^S-99&LAB' })
);

test('ORU: one LOINC-coded ISiKLaboruntersuchung per OBX and a DiagnosticReport per OBR', () => {
  const r = map(ORU);
  const obs = resources(r, 'Observation');
  assert.equal(obs.length, 4);
  for (const o of obs) {
    assert.deepEqual(o.meta.profile, [hub.PROFILE.labObservation]);
    assert.equal(o.category[0].coding[0].code, 'laboratory');
    assert.equal(o.code.coding[0].system, 'http://loinc.org');
  }
  assert.deepEqual(obs.map((o) => o.code.coding[0].code), ['2951-2', '2823-3', '1988-5', '2160-0']);
  // the local code is kept next to LOINC
  assert.deepEqual(obs[0].code.coding[1], { system: 'https://fhir.klinikum-musterstadt.example/CodeSystem/labor-lokal', code: 'NA', display: 'Natrium' });

  const [report] = resources(r, 'DiagnosticReport');
  assert.equal(report.code.coding[0].code, '24326-1');
  assert.equal(report.identifier[0].value, 'LAB-2026-5512');
  assert.equal(report.basedOn[0].identifier.value, 'ANF-778');
  assert.deepEqual(report.result.map((x: any) => x.reference), entries(r, 'Observation').map((e) => e.fullUrl));
  assert.equal(report.issued, '2026-11-17T10:25:00+01:00');
});

test('ORU: UCUM quantities, decimal commas, comparators, reference ranges, flags, notes', () => {
  const [na, k, crp, krea] = resources(map(ORU), 'Observation');
  assert.deepEqual(na.valueQuantity, { value: 138, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' });
  assert.deepEqual(na.referenceRange[0].low, { value: 135, unit: 'mmol/L', system: 'http://unitsofmeasure.org', code: 'mmol/L' });
  assert.equal(k.valueQuantity.value, 5.9);
  assert.equal(k.interpretation[0].coding[0].code, 'H');
  assert.equal(k.note[0].text, 'Probe leicht hämolytisch');
  assert.equal(crp.valueQuantity.comparator, '<');
  assert.equal(crp.valueQuantity.code, 'mg/dL');
  assert.equal(crp.referenceRange[0].high.value, 0.5);
  assert.equal(krea.status, 'preliminary');
  assert.equal(krea.valueQuantity.code, 'mg/dL');
  assert.equal(na.specimen.identifier.value, 'S-99');
  assert.equal(na.effectiveDateTime, '2026-11-17T09:00:00+01:00');
});

test('ORU never overwrites demographics and waits for its encounter', () => {
  const r = map(ORU);
  const [p] = entries(r, 'Patient');
  assert.equal(p.request.method, 'POST');
  assert.match(p.request.ifNoneExist, /^identifier=/);
  const [o] = resources(r, 'Observation');
  assert.match(o.encounter.reference, /^Encounter\?identifier=/);
  assert.deepEqual(r.hints.requires.map((x) => x.identifier.value), ['F2026000123']);
  assert.equal(r.hints.statefulPatient, undefined);
});

test('ORU: observation identifiers make re-sent results update in place', () => {
  const r = map(ORU);
  const ids = entries(r, 'Observation').map((e) => decodeURIComponent(e.request.url));
  assert.ok(ids[0].endsWith('laborbefund-observation|LAB-2026-5512-NA-1'), ids[0]);
});

test('ORU: an unmapped local lab code fails loudly (ISiK requires LOINC)', () => {
  const raw = ORU.replace('NA^Natrium^L', 'XYZ^Unbekannt^L');
  const e = expectMappingError(() => map(raw));
  assert.equal(e.code, 'TERMINOLOGY_UNMAPPED');
  assert.equal(e.location, 'OBX[1]-3');
});

test('ORU: an unmapped unit fails loudly (ISiK requires UCUM)', () => {
  const raw = ORU.replace('|138|mmol/l|', '|138|Hühnereier|');
  assert.equal(expectMappingError(() => map(raw)).location, 'OBX[1]-6');
});

test('ORU: cancelled results carry a data-absent-reason instead of a value', () => {
  const original = seg('OBX', { 1: '2', 2: 'NM', 3: 'K^Kalium^L', 5: '5,9', 6: 'mmol/l', 7: '3.5-5.1', 8: 'H', 11: 'F' });
  assert.ok(ORU.includes(original));
  const raw = ORU.replace(original, seg('OBX', { 1: '2', 2: 'NM', 3: 'K^Kalium^L', 6: 'mmol/l', 11: 'X' }));
  const k = resources(map(raw), 'Observation')[1];
  assert.equal(k.status, 'cancelled');
  assert.equal(k.dataAbsentReason.coding[0].code, 'not-performed');
  assert.equal(k.valueQuantity, undefined);
});

test('OML^O21: ServiceRequest keyed by placer number, with status from ORC-1', () => {
  const raw = hl7(
    MSH('OML^O21^OML_O21', 'ORD0001'),
    PID_MUELLER,
    pv1(),
    seg('ORC', { 1: 'NW', 2: 'ANF-779', 9: '20261117084500', 12: '123456789^Weber^Lena^^^Dr.' }),
    seg('TQ1', { 1: '1', 9: 'S' }),
    seg('OBR', { 1: '1', 2: 'ANF-779', 4: 'BB^Kleines Blutbild^L' }),
    seg('NTE', { 1: '1', 3: 'bitte bis 10 Uhr' })
  );
  const r = map(raw);
  const [sr] = resources(r, 'ServiceRequest');
  assert.equal(sr.status, 'active');
  assert.equal(sr.intent, 'order');
  assert.equal(sr.priority, 'stat');
  assert.equal(sr.code.coding[0].code, '58410-2');
  assert.equal(sr.identifier[0].value, 'ANF-779');
  assert.equal(sr.requester.display, 'Dr. Lena Weber');
  assert.equal(sr.authoredOn, '2026-11-17T08:45:00+01:00');
  assert.equal(sr.note[0].text, 'bitte bis 10 Uhr');
  assert.equal(sr.category[0].coding[0].code, '108252007');

  const cancel = map(raw.replace('ORC|NW|', 'ORC|CA|').replace('ORD0001', 'ORD0002'));
  assert.equal(resources(cancel, 'ServiceRequest')[0].status, 'revoked');
  assert.equal(entries(cancel, 'ServiceRequest')[0].request.url, entries(r, 'ServiceRequest')[0].request.url);
});

const PDF = Buffer.from('%PDF-1.4\n% synthetic test document\n').toString('base64');
const MDM = hl7(
  MSH('MDM^T02^MDM_T02', 'DOC0001'),
  seg('EVN', { 1: 'T02', 2: '20261120110000' }),
  PID_MUELLER,
  pv1(),
  seg('TXA', { 1: '1', 2: 'ENTL^Entlassbrief^L', 3: 'AP', 4: '20261120105500', 5: '^Weber^Lena^^^Dr.', 6: '20261120104000', 12: 'DOC-2026-000042', 16: 'Entlassbrief Anna von Müller', 17: 'AU', 18: 'N', 19: 'AV' }),
  seg('OBX', { 1: '1', 2: 'ED', 3: 'ENTL^Entlassbrief^L', 5: `^AP^PDF^Base64^${PDF}`, 11: 'F' })
);

test('MDM^T02: ISiKDokumentenMetadaten with KDL, XDS type/class, and an ISiKBinary', () => {
  const r = map(MDM);
  const [doc] = resources(r, 'DocumentReference');
  const [bin] = resources(r, 'Binary');
  assert.deepEqual(doc.meta.profile, [hub.PROFILE.documentReference]);
  assert.deepEqual(doc.masterIdentifier, { system: 'https://fhir.klinikum-musterstadt.example/sid/dokument', value: 'DOC-2026-000042' });
  assert.deepEqual(doc.type.coding.map((c: any) => [c.system.split('/').pop(), c.code, c.display]), [
    ['kdl', 'AD010104', 'Entlassungsbericht extern'],
    ['IHEXDStypeCode', 'BERI', 'Arztberichte']
  ]);
  assert.equal(doc.category[0].coding[0].code, 'BRI');
  assert.equal(doc.status, 'current');
  assert.equal(doc.docStatus, 'final');
  assert.equal(doc.date, '2026-11-20T10:55:00+01:00');
  assert.equal(doc.securityLabel[0].coding[0].code, 'N');
  assert.equal(doc.content[0].attachment.url, 'Binary/' + bin.id);
  assert.equal(doc.content[0].attachment.language, 'de-DE');
  assert.equal(doc.content[0].format.code, 'urn:ihe:iti:xds:2017:mimeTypeSufficient');
  assert.equal(doc.context.facilityType.coding[0].code, 'KHS');
  assert.match(doc.context.encounter[0].reference, /^Encounter\?identifier=/);
  assert.equal(bin.contentType, 'application/pdf');
  assert.equal(bin.data, PDF);
  assert.equal(entries(r, 'Binary')[0].request.url, 'Binary/' + bin.id);
});

test('MDM^T10: the new version replaces the old one', () => {
  const raw = MDM.replace('MDM^T02^MDM_T02', 'MDM^T10^MDM_T02').replace('DOC-2026-000042|', 'DOC-2026-000043|DOC-2026-000042|');
  const r = map(raw);
  const [doc] = resources(r, 'DocumentReference');
  assert.equal(doc.relatesTo[0].code, 'replaces');
  assert.equal(doc.relatesTo[0].target.identifier.value, 'DOC-2026-000042');
  assert.equal(r.hints.supersede!.identifier.value, 'DOC-2026-000042');
});

test('MDM: documents need content and a known type', () => {
  assert.equal(expectMappingError(() => map(MDM.replace(/\rOBX.*$/, ''))).location, 'OBX-5');
  assert.equal(expectMappingError(() => map(MDM.replace('ENTL^Entlassbrief^L|AP', 'FOO^Foo^L|AP'))).code, 'TERMINOLOGY_UNMAPPED');
});
