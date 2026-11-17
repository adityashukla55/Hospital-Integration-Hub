import type { Annotation, CodeableConcept, Coding, DiagnosticReport, Identifier, Observation, Quantity, Reference } from 'fhir/r4';
import { MappingError } from '../errors';
import { conditionalReference, ref } from '../fhir/bundle';
import { CS, PROFILE } from '../fhir/profiles';
import { Cwe, readCwe, readEi } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { INTERPRETATION, OBSERVATION_STATUS, REPORT_STATUS } from '../terminology/v2tables';
import { trim } from '../util/lang';
import { toFhirDateTime, toFhirInstant } from '../util/time';
import { issue, MapContext } from './context';
import { encounterIdentifier, visitNumber } from './encounter';
import { mapPatient } from './patient';

/** One ORC/OBR order group of an ORU^R01 with its results and notes. */
interface OrderGroup {
  orc?: Segment;
  obr: Segment;
  results: Array<{ obx: Segment; notes: Segment[]; position: number }>;
  notes: Segment[];
  spm?: Segment;
}

function groupOrders(segments: Segment[]): OrderGroup[] {
  var groups: OrderGroup[] = [];
  var current: OrderGroup | undefined;
  var pendingOrc: Segment | undefined;
  var obxCount = 0;
  for (var i = 0; i < segments.length; i++) {
    var s = segments[i];
    switch (s.name) {
      case 'ORC':
        pendingOrc = s;
        break;
      case 'OBR':
        current = { orc: pendingOrc, obr: s, results: [], notes: [] };
        pendingOrc = undefined;
        groups.push(current);
        break;
      case 'OBX':
        if (!current) throw new MappingError('PARSE_ERROR', 'OBX before any OBR', 'OBX');
        obxCount++;
        current.results.push({ obx: s, notes: [], position: obxCount });
        break;
      case 'NTE':
        if (current && current.results.length) current.results[current.results.length - 1].notes.push(s);
        else if (current) current.notes.push(s);
        break;
      case 'SPM':
        if (current) current.spm = s;
        break;
    }
  }
  return groups;
}

/**
 * ORU^R01 to ISiKLaboruntersuchung Observations and a DiagnosticReport per
 * order. Lab results never overwrite demographics: the Patient is only
 * created when it does not exist yet (lab messages can arrive before ADT).
 */
export function mapResults(ctx: MapContext): void {
  var msg = ctx.msg;
  var pid = msg.require('PID');
  var patient = mapPatient(ctx, pid);
  var patientFullUrl = ctx.tx.createIfMissing(patient.resource, patient.identifier);
  var encounterRef = encounterReference(ctx, msg.segment('PV1'));

  var groups = groupOrders(msg.segments);
  if (!groups.length) throw new MappingError('MISSING_REQUIRED_FIELD', 'ORU^R01 needs at least one OBR', 'OBR');

  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    var obr = group.obr;
    var loc = 'OBR[' + (g + 1) + ']';
    var filler = readEi(obr.rep(3)).id || (group.orc ? readEi(group.orc.rep(3)).id : '');
    var placer = readEi(obr.rep(2)).id || (group.orc ? readEi(group.orc.rep(2)).id : '');
    if (!filler) throw new MappingError('MISSING_REQUIRED_FIELD', 'filler order number is required to identify results', loc + '-3');

    var effective = toFhirDateTime(obr.get(7, 1), ctx.cfg.timezone);
    var issued = toFhirInstant(obr.get(22, 1), ctx.cfg.timezone);
    var specimenId = group.spm ? group.spm.get(2, 2) || group.spm.get(2, 1) : '';

    var resultRefs: Reference[] = [];
    for (var r = 0; r < group.results.length; r++) {
      var item = group.results[r];
      var obs = mapObservation(ctx, item.obx, item.notes, {
        filler: filler,
        patientFullUrl: patientFullUrl,
        encounterRef: encounterRef,
        effective: effective,
        issued: issued,
        specimenId: specimenId,
        position: item.position
      });
      if (!obs) continue;
      resultRefs.push(ref(ctx.tx.upsert(obs.resource, obs.identifier)));
    }

    var reportIdentifier: Identifier = { system: ctx.cfg.systems.diagnosticReport, value: filler };
    var report: DiagnosticReport = {
      resourceType: 'DiagnosticReport',
      identifier: [reportIdentifier],
      basedOn: placer ? [{ type: 'ServiceRequest', identifier: { system: ctx.cfg.systems.placerOrder, value: placer } }] : undefined,
      status: (REPORT_STATUS[obr.get(25)] || 'final') as DiagnosticReport['status'],
      category: [{ coding: [{ system: CS.v2_0074, code: 'LAB', display: 'Laboratory' }] }],
      code: labCode(ctx, readCwe(obr.rep(4)), loc + '-4', false),
      subject: { reference: patientFullUrl },
      encounter: encounterRef,
      effectiveDateTime: effective,
      issued: issued,
      result: resultRefs,
      conclusion: notesText(group.notes)
    };
    ctx.tx.upsert(report, reportIdentifier);
  }
}

/** PV1-19 as a conditional reference; delivery waits until that Encounter exists. */
export function encounterReference(ctx: MapContext, pv1: Segment | undefined): Reference | undefined {
  var number = visitNumber(pv1);
  if (!number) return undefined;
  var identifier = encounterIdentifier(ctx, number);
  ctx.hints.requires.push({ resourceType: 'Encounter', identifier: identifier, location: 'PV1-19' });
  return conditionalReference('Encounter', identifier);
}

interface ObservationInput {
  filler: string;
  patientFullUrl: string;
  encounterRef?: Reference;
  effective?: string;
  issued?: string;
  specimenId: string;
  position: number;
}

function mapObservation(ctx: MapContext, obx: Segment, notes: Segment[], input: ObservationInput): { resource: Observation; identifier: Identifier } | undefined {
  var loc = 'OBX[' + (obx.get(1) || input.position) + ']';
  var valueType = obx.get(2);
  if (valueType === 'ED' || valueType === 'RP') {
    issue(ctx, 'information', 'OBX_SKIPPED', 'embedded documents in ORU are not mapped to Observations; send them via MDM', loc);
    return undefined;
  }
  var code = readCwe(obx.rep(3));
  if (!code.code) throw new MappingError('MISSING_REQUIRED_FIELD', 'observation identifier is required', loc + '-3');

  var subId = obx.get(4) || String(input.position);
  var identifier: Identifier = { system: ctx.cfg.systems.observation, value: input.filler + '-' + code.code + '-' + subId };
  var status = OBSERVATION_STATUS[obx.get(11)] || 'final';

  var observation: Observation = {
    resourceType: 'Observation',
    meta: { profile: [PROFILE.labObservation] },
    identifier: [identifier],
    status: status as Observation['status'],
    category: [{ coding: [{ system: CS.observationCategory, code: 'laboratory', display: 'Laboratory' }] }],
    code: labCode(ctx, code, loc + '-3', true),
    subject: { reference: input.patientFullUrl },
    encounter: input.encounterRef,
    effectiveDateTime: toFhirDateTime(obx.get(14, 1), ctx.cfg.timezone) || input.effective,
    issued: input.issued,
    interpretation: interpretation(ctx, obx, loc),
    note: notesAnnotations(notes),
    specimen: input.specimenId ? { identifier: { system: ctx.cfg.systems.specimen, value: input.specimenId } } : undefined
  };

  var rawValue = obx.raw(5);
  if (!rawValue || status === 'cancelled' || status === 'entered-in-error') {
    observation.dataAbsentReason = { coding: [{ system: CS.dataAbsentReason, code: status === 'cancelled' ? 'not-performed' : 'unknown' }] };
  } else {
    setValue(ctx, observation, obx, valueType, loc);
  }
  return { resource: observation, identifier: identifier };
}

/**
 * Local lab code to LOINC through the lab ConceptMap ($translate). For
 * Observations ISiK requires a LOINC coding, so an unmapped code fails the
 * message loudly (dead letter) instead of storing a non-conformant result.
 */
function labCode(ctx: MapContext, code: Cwe, loc: string, loincRequired: boolean): CodeableConcept {
  var codings: Coding[] = [];
  var loinc: Coding | undefined;
  if (code.system === 'LN' || code.system === 'LOINC') {
    loinc = { system: CS.loinc, code: code.code, display: code.text || undefined };
  } else if (code.altSystem === 'LN' && code.altCode) {
    loinc = { system: CS.loinc, code: code.altCode, display: code.altText || undefined };
  }
  var localCode = code.system === 'LN' || code.system === 'LOINC' ? '' : code.code;
  if (!loinc && localCode) {
    var t = ctx.terminology.translate(ctx.cfg.conceptMaps.labToLoinc, ctx.cfg.systems.localLabCodes, localCode);
    if (t) loinc = { system: CS.loinc, code: t.code, display: t.display };
  }
  if (loinc) codings.push(loinc);
  if (localCode) codings.push({ system: ctx.cfg.systems.localLabCodes, code: localCode, display: code.text || undefined });
  if (!loinc && loincRequired) {
    throw new MappingError('TERMINOLOGY_UNMAPPED', 'local lab code "' + code.code + '" has no LOINC mapping in ' + ctx.cfg.conceptMaps.labToLoinc, loc);
  }
  return { coding: codings, text: code.text || undefined };
}

function setValue(ctx: MapContext, observation: Observation, obx: Segment, valueType: string, loc: string): void {
  switch (valueType) {
    case 'NM': {
      var num = parseNumber(obx.get(5));
      if (num === undefined) throw new MappingError('INVALID_VALUE', 'numeric result "' + obx.get(5) + '" is not a number', loc + '-5');
      observation.valueQuantity = quantity(ctx, num, readCwe(obx.rep(6)), loc + '-6');
      observation.referenceRange = referenceRange(ctx, obx, loc);
      return;
    }
    case 'SN': {
      // structured numeric: comparator ^ num1 [^ separator ^ num2]
      var comparator = obx.get(5, 1);
      var n1 = parseNumber(obx.get(5, 2));
      var separator = obx.get(5, 3);
      if (n1 !== undefined && !separator) {
        var q = quantity(ctx, n1, readCwe(obx.rep(6)), loc + '-6');
        if (comparator === '<' || comparator === '<=' || comparator === '>' || comparator === '>=') q.comparator = comparator as Quantity['comparator'];
        observation.valueQuantity = q;
        observation.referenceRange = referenceRange(ctx, obx, loc);
      } else {
        observation.valueString = trim([obx.get(5, 1), obx.get(5, 2), obx.get(5, 3), obx.get(5, 4)].join(' '));
      }
      return;
    }
    case 'CE':
    case 'CWE': {
      var c = readCwe(obx.rep(5));
      observation.valueCodeableConcept = { coding: c.code ? [{ code: c.code, display: c.text || undefined }] : undefined, text: c.text || c.code };
      return;
    }
    default: {
      // ST, TX, FT: repetitions are lines
      var reps = obx.reps(5);
      var lines: string[] = [];
      for (var i = 0; i < reps.length; i++) lines.push(reps[i].component(1));
      observation.valueString = lines.join('\n');
    }
  }
}

function parseNumber(value: string): number | undefined {
  var v = trim(value);
  if (!v) return undefined;
  // German systems sometimes send decimal commas
  if (/^-?\d+,\d+$/.test(v)) v = v.replace(',', '.');
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return undefined;
  return parseFloat(v);
}

/** UCUM is mandatory for ISiK lab quantities; local units go through the units ConceptMap. */
function quantity(ctx: MapContext, value: number, unit: Cwe, loc: string): Quantity {
  if (!unit.code && !unit.text) return { value: value, system: CS.ucum, code: '1', unit: '1' };
  if (unit.system === 'UCUM' || unit.system === 'ANS+') return { value: value, unit: unit.text || unit.code, system: CS.ucum, code: unit.code };
  var local = unit.code || unit.text;
  // unit strings are matched case-insensitively ("mmol/l" = "mmol/L"); the ConceptMap keys are lower-case
  var t = ctx.terminology.translate(ctx.cfg.conceptMaps.unitsToUcum, ctx.cfg.systems.localUnits, local.toLowerCase());
  if (!t) throw new MappingError('TERMINOLOGY_UNMAPPED', 'unit "' + local + '" has no UCUM mapping in ' + ctx.cfg.conceptMaps.unitsToUcum, loc);
  return { value: value, unit: t.display || t.code, system: CS.ucum, code: t.code };
}

function referenceRange(ctx: MapContext, obx: Segment, loc: string): Observation['referenceRange'] {
  var range = trim(obx.get(7));
  if (!range) return undefined;
  var unit = readCwe(obx.rep(6));
  var m = /^(-?[\d.,]+)\s*-\s*(-?[\d.,]+)$/.exec(range);
  var lowerOnly = /^(>=?)\s*(-?[\d.,]+)$/.exec(range);
  var upperOnly = /^(<=?)\s*(-?[\d.,]+)$/.exec(range);
  try {
    if (m) return [{ low: rangeQuantity(ctx, m[1], unit, loc), high: rangeQuantity(ctx, m[2], unit, loc), text: range }];
    if (lowerOnly) return [{ low: rangeQuantity(ctx, lowerOnly[2], unit, loc), text: range }];
    if (upperOnly) return [{ high: rangeQuantity(ctx, upperOnly[2], unit, loc), text: range }];
  } catch (e) {
    // fall through to a text-only range
  }
  return [{ text: range }];
}

function rangeQuantity(ctx: MapContext, value: string, unit: Cwe, loc: string): Quantity {
  var n = parseNumber(value);
  if (n === undefined) throw new MappingError('INVALID_VALUE', 'reference range bound "' + value + '" is not a number', loc + '-7');
  var q = quantity(ctx, n, unit, loc + '-6');
  return { value: q.value, unit: q.unit, system: q.system, code: q.code };
}

function interpretation(ctx: MapContext, obx: Segment, loc: string): CodeableConcept[] | undefined {
  var reps = obx.reps(8);
  var out: CodeableConcept[] = [];
  for (var i = 0; i < reps.length; i++) {
    var flag = reps[i].c(1);
    if (!flag) continue;
    var m = INTERPRETATION[flag];
    if (m) out.push({ coding: [{ system: CS.interpretation, code: m.code, display: m.display }] });
    else issue(ctx, 'warning', 'UNMAPPED_CODE', 'abnormal flag "' + flag + '" not mapped', loc + '-8');
  }
  return out.length ? out : undefined;
}

function notesAnnotations(notes: Segment[]): Annotation[] | undefined {
  var out: Annotation[] = [];
  for (var i = 0; i < notes.length; i++) {
    var text = noteText(notes[i]);
    if (text) out.push({ text: text });
  }
  return out.length ? out : undefined;
}

function notesText(notes: Segment[]): string | undefined {
  var parts: string[] = [];
  for (var i = 0; i < notes.length; i++) {
    var t = noteText(notes[i]);
    if (t) parts.push(t);
  }
  return parts.length ? parts.join('\n') : undefined;
}

function noteText(nte: Segment): string {
  var reps = nte.reps(3);
  var lines: string[] = [];
  for (var i = 0; i < reps.length; i++) lines.push(reps[i].component(1));
  return trim(lines.join('\n'));
}
