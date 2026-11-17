import type { Identifier } from 'fhir/r4';
import { MappingError } from '../errors';
import { readCx } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { contains } from '../util/lang';
import { issue, MapContext } from './context';
import { mapCondition, MappedCondition } from './condition';
import { mapAccount, mapCoverage } from './coverage';
import { diagnosisEntries, encounterIdentifier, mapEncounter, visitNumber } from './encounter';
import { kvnrIdentifier, mapPatient, patientNumberIdentifier } from './patient';

export var ADT_EVENTS = ['A01', 'A02', 'A03', 'A04', 'A08', 'A40'];

/**
 * ADT is the source of truth for demographics and contacts, so Patient and
 * Encounter are written with conditional updates and flagged as stateful:
 * the delivery step reconciles them with the stored version (merge aliases,
 * out-of-order events, location history) before sending.
 */
export function mapAdt(ctx: MapContext, event: string): void {
  var msg = ctx.msg;
  var pid = msg.require('PID');
  var patient = mapPatient(ctx, pid);

  if (event === 'A40') {
    mapMerge(ctx, patient.resource, patient.identifier);
    return;
  }

  var patientFullUrl = ctx.tx.upsert(patient.resource, patient.identifier, { stateful: true });
  ctx.hints.statefulPatient = { fullUrl: patientFullUrl, identifier: patient.identifier };

  var pv1 = msg.segment('PV1');
  var fallnummer = visitNumber(pv1);
  if (!pv1 || !fallnummer || pv1.get(2) === 'N') {
    if (event === 'A08') {
      issue(ctx, 'information', 'NO_VISIT', 'A08 without visit number: only the patient is updated', 'PV1-19');
      return;
    }
    throw new MappingError('MISSING_REQUIRED_FIELD', 'visit number (Fallnummer) is required for ADT^' + event, 'PV1-19');
  }

  // Coverage (statutory insurance) from IN1; its KVNR also completes the Patient.
  var coverageFullUrl: string | undefined;
  var in1s = msg.all('IN1');
  var kvnr = patient.kvnr;
  for (var i = 0; i < in1s.length && !coverageFullUrl; i++) {
    var officialName = patient.resource.name ? patient.resource.name[0] : undefined;
    var cov = mapCoverage(ctx, in1s[i], patientFullUrl, patient.identifier.value as string, officialName, kvnr);
    if (!cov) continue;
    coverageFullUrl = ctx.tx.upsert(cov.resource, cov.identifier);
    if (cov.kvnr && !kvnr) {
      kvnr = cov.kvnr;
      (patient.resource.identifier as Identifier[]).push(kvnrIdentifier(kvnr));
      ctx.tx.upsert(patient.resource, patient.identifier, { stateful: true });
    }
  }

  var account = mapAccount(ctx, fallnummer, patientFullUrl, coverageFullUrl);
  var accountFullUrl = ctx.tx.upsert(account.resource, account.identifier);

  // Register the Encounter first so diagnoses can reference it, then fill it in.
  var encIdentifier = encounterIdentifier(ctx, fallnummer);
  var first = mapEncounter(ctx, pv1, msg.segment('PV2'), {
    event: event,
    patientFullUrl: patientFullUrl,
    accountFullUrl: accountFullUrl,
    accountIdentifier: account.identifier,
    diagnoses: []
  });
  var encounterFullUrl = ctx.tx.upsert(first.resource, encIdentifier, { stateful: true });

  var conditions = mapDiagnoses(ctx, patientFullUrl, encounterFullUrl, fallnummer);
  if (conditions.length) {
    var diagnoses: Array<{ fullUrl: string; use: MappedCondition['use']; mainDiagnosis: boolean; rank?: number }> = [];
    for (var c = 0; c < conditions.length; c++) {
      var fullUrl = ctx.tx.upsert(conditions[c].resource, conditions[c].identifier);
      diagnoses.push({ fullUrl: fullUrl, use: conditions[c].use, mainDiagnosis: conditions[c].mainDiagnosis, rank: conditions[c].rank });
    }
    // reuse the first mapping (its issues are already recorded) and attach the diagnoses
    first.resource.diagnosis = diagnosisEntries(diagnoses);
    ctx.tx.upsert(first.resource, encIdentifier, { stateful: true });
  }
  ctx.hints.statefulEncounters.push({ fullUrl: encounterFullUrl, identifier: encIdentifier, event: event });
}

function mapDiagnoses(ctx: MapContext, patientFullUrl: string, encounterFullUrl: string, fallnummer: string): MappedCondition[] {
  var out: MappedCondition[] = [];
  var segs = ctx.msg.segments;
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].name !== 'DG1') continue;
    var next: Segment | undefined = segs[i + 1];
    var zdg = next && next.name === 'ZDG' ? next : undefined;
    out.push(mapCondition(ctx, segs[i], zdg, patientFullUrl, encounterFullUrl, fallnummer));
  }
  return out;
}

/**
 * ADT^A40 (merge patient - patient identifier list). PID is the surviving
 * patient, MRG-1 the retired Patientennummer. The survivor keeps the retired
 * number as an "old" identifier so late messages for it still resolve; the
 * retired record and all references to it are rewritten during delivery.
 */
function mapMerge(ctx: MapContext, survivor: import('fhir/r4').Patient, survivorIdentifier: Identifier): void {
  var mrg = ctx.msg.require('MRG');
  var retiredNumber = '';
  var reps = mrg.reps(1);
  for (var i = 0; i < reps.length && !retiredNumber; i++) {
    var cx = readCx(reps[i]);
    var own = !cx.assigningAuthority || contains(ctx.cfg.patientAssigningAuthorities, cx.assigningAuthority);
    if (cx.id && own && (cx.typeCode === '' || cx.typeCode === 'PI' || cx.typeCode === 'MR' || cx.typeCode === 'PN')) retiredNumber = cx.id;
  }
  if (!retiredNumber) throw new MappingError('MISSING_REQUIRED_FIELD', 'prior patient number is required for a merge', 'MRG-1');
  if (retiredNumber === survivorIdentifier.value) throw new MappingError('INVALID_VALUE', 'prior and surviving patient number are identical', 'MRG-1');

  var retiredIdentifier = patientNumberIdentifier(ctx, retiredNumber);
  var old: Identifier = {
    use: 'old',
    type: retiredIdentifier.type,
    system: retiredIdentifier.system,
    value: retiredNumber
  };
  (survivor.identifier as Identifier[]).push(old);
  var survivorFullUrl = ctx.tx.upsert(survivor, survivorIdentifier, { stateful: true });
  ctx.hints.statefulPatient = { fullUrl: survivorFullUrl, identifier: survivorIdentifier };
  ctx.hints.merge = { survivorFullUrl: survivorFullUrl, survivorIdentifier: survivorIdentifier, retiredIdentifier: retiredIdentifier };
}
