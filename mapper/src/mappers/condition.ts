import type { Coding, Condition, Extension, Identifier } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS, EXT, PROFILE } from '../fhir/profiles';
import { readEi } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { DIAGNOSESICHERHEIT, SEITENLOKALISATION } from '../terminology/v2tables';
import { toFhirDateTime } from '../util/time';
import { issue, MapContext } from './context';

var ICD_CODE = /^[A-Z][0-9][A-Z0-9](\.?[A-Z0-9]{0,4})?$/;
var ICD_SYSTEMS: { [v2: string]: boolean } = { I10: true, I10G: true, ICD10GM: true, 'ICD-10-GM': true, ICD10: true };

export interface MappedCondition {
  resource: Condition;
  identifier: Identifier;
  use: 'referral-diagnosis' | 'treatment-diagnosis';
  mainDiagnosis: boolean;
  rank?: number;
}

/**
 * DG1 (+ optional site-specific ZDG segment directly after it) to ISiKDiagnose.
 *
 * ZDG|<set id>|<Diagnosesicherheit A/G/V/Z>|<Seitenlokalisation R/L/B>
 * Many German KIS send these qualifiers in a Z-segment because DG1 has no
 * field for them; the hub documents the convention in docs/mapping-spec.md.
 */
export function mapCondition(
  ctx: MapContext,
  dg1: Segment,
  zdg: Segment | undefined,
  patientFullUrl: string,
  encounterFullUrl: string,
  fallnummer: string
): MappedCondition {
  var loc = 'DG1[' + (dg1.get(1) || '?') + ']';
  var rawCode = dg1.get(3, 1);
  var system = dg1.get(3, 3);
  if (!rawCode) throw new MappingError('MISSING_REQUIRED_FIELD', 'diagnosis code is required', loc + '-3');
  if (system && !ICD_SYSTEMS[system.toUpperCase()]) {
    throw new MappingError('TERMINOLOGY_UNMAPPED', 'coding system "' + system + '" is not ICD-10-GM', loc + '-3.3');
  }

  // German coding marks: † (primary), * (secondary), ! (additional)
  var marker = '';
  var code = rawCode.replace(/\s+/g, '');
  var mm = /^(.*?)([†*!+])$/.exec(code);
  if (mm) {
    marker = mm[2] === '+' ? '†' : mm[2];
    code = mm[1];
  }
  if (!ICD_CODE.test(code)) throw new MappingError('INVALID_VALUE', '"' + rawCode + '" is not a valid ICD-10-GM code', loc + '-3');

  var version = dg1.get(3, 7) || ctx.cfg.icd10gmVersion;
  var coding: Coding & { extension?: Extension[] } = {
    system: CS.icd10gm,
    version: version,
    code: code,
    display: dg1.get(3, 2) || dg1.get(4) || undefined
  };
  var codingExt: Extension[] = [];
  if (marker) codingExt.push({ url: EXT.icdMehrfach, valueCoding: { system: CS.icdMehrfach, code: marker } });

  var sicherheit = zdg ? zdg.get(2) : '';
  var seite = zdg ? zdg.get(3) : '';
  if (seite) {
    if (SEITENLOKALISATION[seite]) codingExt.push({ url: EXT.icdSeite, valueCoding: { system: CS.icdSeite, code: seite, display: SEITENLOKALISATION[seite] } });
    else issue(ctx, 'warning', 'UNMAPPED_CODE', 'Seitenlokalisation "' + seite + '" unknown', 'ZDG-3');
  }
  var qualifier = sicherheit ? DIAGNOSESICHERHEIT[sicherheit] : undefined;
  if (sicherheit && !qualifier) issue(ctx, 'warning', 'UNMAPPED_CODE', 'Diagnosesicherheit "' + sicherheit + '" unknown', 'ZDG-2');
  if (qualifier) codingExt.push({ url: EXT.icdSicherheit, valueCoding: { system: CS.icdSicherheit, code: sicherheit, display: qualifier.display } });
  if (codingExt.length) coding.extension = codingExt;

  var diagnosisType = dg1.get(6);
  var use: MappedCondition['use'] = diagnosisType === 'A' ? 'referral-diagnosis' : 'treatment-diagnosis';
  var priority = dg1.get(15);
  var rank = /^\d+$/.test(priority) ? parseInt(priority, 10) : undefined;

  var ei = readEi(dg1.rep(20));
  var idValue = ei.id || fallnummer + '-' + code + (marker ? marker : '') + '-' + (diagnosisType || 'W');
  var identifier: Identifier = { system: ctx.cfg.systems.condition, value: idValue };

  var recorded = toFhirDateTime(dg1.get(5, 1), ctx.cfg.timezone);
  if (!recorded) {
    recorded = ctx.eventTime;
    issue(ctx, 'information', 'DERIVED_RECORDED_DATE', 'diagnosis date/time missing; event time used as recordedDate', loc + '-5');
  }

  var condition: Condition = {
    resourceType: 'Condition',
    meta: { profile: [PROFILE.condition] },
    identifier: [identifier],
    clinicalStatus: qualifier && !qualifier.clinical ? undefined : { coding: [{ system: CS.conditionClinical, code: qualifier ? (qualifier.clinical as string) : 'active' }] },
    verificationStatus: qualifier ? { coding: [{ system: CS.conditionVerification, code: qualifier.verification as string }] } : undefined,
    code: { coding: [coding], text: dg1.get(4) || dg1.get(3, 2) || undefined },
    subject: { reference: patientFullUrl },
    encounter: { reference: encounterFullUrl },
    recordedDate: recorded
  };
  return { resource: condition, identifier: identifier, use: use, mainDiagnosis: rank === 1, rank: rank };
}
