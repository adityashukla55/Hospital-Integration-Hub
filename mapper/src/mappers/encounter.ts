import type { Coding, Encounter, EncounterLocation, Extension, Identifier } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS, EXT, PROFILE, SID } from '../fhir/profiles';
import { readCx, readPl } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { AUFNAHMEANLASS, PATIENT_CLASS } from '../terminology/v2tables';
import { toFhirDateTime } from '../util/time';
import { issue, MapContext } from './context';

export function encounterIdentifier(ctx: MapContext, value: string): Identifier {
  return {
    type: { coding: [{ system: CS.v2_0203, code: 'VN' }] },
    system: ctx.cfg.systems.encounter,
    value: value
  };
}

/** PV1-19 visit number (Fallnummer), or '' when absent. */
export function visitNumber(pv1: Segment | undefined): string {
  if (!pv1) return '';
  var r = pv1.rep(19);
  return r ? readCx(r).id : '';
}

export interface EncounterInput {
  event: string;
  patientFullUrl: string;
  accountFullUrl?: string;
  accountIdentifier?: Identifier;
  diagnoses: Array<{ fullUrl: string; use: 'referral-diagnosis' | 'treatment-diagnosis'; mainDiagnosis: boolean; rank?: number }>;
}

/** Maps PV1 (+PV2) to an ISiKKontaktGesundheitseinrichtung (department-level contact). */
export function mapEncounter(ctx: MapContext, pv1: Segment, pv2: Segment | undefined, input: EncounterInput): { resource: Encounter; identifier: Identifier } {
  var number = visitNumber(pv1);
  if (!number) throw new MappingError('MISSING_REQUIRED_FIELD', 'visit number (Fallnummer) is required for ' + input.event, 'PV1-19');
  var identifier = encounterIdentifier(ctx, number);

  var v2Class = pv1.get(2);
  var cls = PATIENT_CLASS[v2Class];
  if (!cls) throw new MappingError('INVALID_VALUE', 'patient class "' + v2Class + '" has no EncounterClassDE mapping', 'PV1-2');

  var start = toFhirDateTime(pv1.get(44, 1), ctx.cfg.timezone);
  var end = toFhirDateTime(pv1.get(45, 1), ctx.cfg.timezone);
  var status: Encounter['status'];
  switch (input.event) {
    case 'A03':
      status = 'finished';
      break;
    case 'A08':
      status = end ? 'finished' : 'in-progress';
      break;
    default:
      status = 'in-progress';
      end = undefined; // an admit or transfer cannot carry a discharge time
  }
  if (!start) {
    // ISiK-enc-5 / ISiK-enc-2: in-progress and finished contacts need period.start
    start = ctx.eventTime;
    issue(ctx, 'warning', 'DERIVED_ADMIT_TIME', 'admit date/time missing; event time used as period.start', 'PV1-44');
  }
  if (status === 'finished' && !end) {
    end = ctx.eventTime;
    issue(ctx, 'information', 'DERIVED_DISCHARGE_TIME', 'discharge date/time missing; event time used as period.end', 'PV1-45');
  }

  var encounter: Encounter = {
    resourceType: 'Encounter',
    meta: { profile: [PROFILE.encounter] },
    extension: aufnahmegrund(ctx, pv2),
    identifier: [identifier],
    status: status,
    class: { system: CS.v3ActCode, code: cls.code, display: cls.display },
    type: [{ coding: [{ system: CS.kontaktebene, code: 'abteilungskontakt', display: 'Abteilungskontakt' }] }],
    serviceType: fachabteilung(ctx, pv1),
    subject: { reference: input.patientFullUrl },
    period: { start: start, end: end },
    diagnosis: [],
    account: input.accountFullUrl ? [{ reference: input.accountFullUrl, identifier: input.accountIdentifier }] : undefined,
    hospitalization: hospitalization(ctx, pv1),
    location: locations(ctx, pv1, status === 'finished' ? 'completed' : 'active'),
    serviceProvider: {
      identifier: { system: SID.iknr, value: ctx.cfg.facility.iknr },
      display: ctx.cfg.facility.name
    }
  };

  var kontaktart = pv1.get(18);
  if (/^[a-z]+$/.test(kontaktart)) {
    (encounter.type as NonNullable<Encounter['type']>).push({ coding: [{ system: CS.kontaktart, code: kontaktart }] });
  }

  encounter.diagnosis = diagnosisEntries(input.diagnoses);

  // PV1-6 prior location on a transfer (A02) is kept as a completed location.
  if (input.event === 'A02' && pv1.has(6)) {
    var prior = locations(ctx, pv1, 'completed', 6);
    for (var p = 0; p < prior.length; p++) (encounter.location as EncounterLocation[]).push(prior[p]);
  }
  return { resource: encounter, identifier: identifier };
}

/** Encounter.diagnosis with Diagnosetyp and, for the main treatment diagnosis, the Fachabteilungshauptdiagnose subtype. */
export function diagnosisEntries(diagnoses: EncounterInput['diagnoses']): NonNullable<Encounter['diagnosis']> {
  var out: NonNullable<Encounter['diagnosis']> = [];
  for (var i = 0; i < diagnoses.length; i++) {
    var d = diagnoses[i];
    var coding: Coding[] = [{ system: CS.diagnoseTyp, code: d.use }];
    if (d.mainDiagnosis && d.use === 'treatment-diagnosis') coding.push({ system: CS.diagnoseTyp, code: 'department-main-diagnosis' });
    out.push({ condition: { reference: d.fullUrl }, use: { coding: coding }, rank: d.rank });
  }
  return out;
}

function fachabteilung(ctx: MapContext, pv1: Segment): Encounter['serviceType'] {
  var code = pv1.get(10);
  if (!code) return undefined;
  if (/^\d{4}$/.test(code)) return { coding: [{ system: CS.fachabteilung, code: code }] };
  if (/^[0-9A-Z]{4}$/.test(code)) return { coding: [{ system: CS.fachabteilungErweitert, code: code }] };
  issue(ctx, 'warning', 'UNMAPPED_CODE', 'hospital service "' + code + '" is not a Fachabteilungsschlüssel', 'PV1-10');
  return undefined;
}

function hospitalization(ctx: MapContext, pv1: Segment): Encounter['hospitalization'] {
  var h: NonNullable<Encounter['hospitalization']> = {};
  var anlass = pv1.get(4);
  if (anlass) {
    if (AUFNAHMEANLASS[anlass]) h.admitSource = { coding: [{ system: CS.aufnahmeanlass, code: anlass, display: AUFNAHMEANLASS[anlass] }] };
    else issue(ctx, 'warning', 'UNMAPPED_CODE', 'admission type "' + anlass + '" is not a §301 Aufnahmeanlass', 'PV1-4');
  }
  var grund = pv1.get(36);
  if (grund) {
    if (/^\d{3}$/.test(grund)) {
      var ext: Extension = {
        url: EXT.entlassungsgrund,
        extension: [
          { url: 'ErsteUndZweiteStelle', valueCoding: { system: CS.entlassungsgrund12, code: grund.substring(0, 2) } },
          { url: 'DritteStelle', valueCoding: { system: CS.entlassungsgrund3, code: grund.substring(2, 3) } }
        ]
      };
      h.dischargeDisposition = { extension: [ext] };
    } else {
      issue(ctx, 'warning', 'UNMAPPED_CODE', 'discharge disposition "' + grund + '" is not a 3-digit §301 Entlassungsgrund', 'PV1-36');
    }
  }
  return h;
}

function aufnahmegrund(ctx: MapContext, pv2: Segment | undefined): Extension[] | undefined {
  if (!pv2) return undefined;
  var code = pv2.get(3, 1);
  if (!code) return undefined;
  if (!/^\d{4}$/.test(code)) {
    issue(ctx, 'warning', 'UNMAPPED_CODE', 'admit reason "' + code + '" is not a 4-digit §301 Aufnahmegrund', 'PV2-3');
    return undefined;
  }
  return [
    {
      url: EXT.aufnahmegrund,
      extension: [
        { url: 'ErsteUndZweiteStelle', valueCoding: { system: CS.aufnahmegrund12, code: code.substring(0, 2) } },
        { url: 'DritteStelle', valueCoding: { system: CS.aufnahmegrund3, code: code.substring(2, 3) } },
        { url: 'VierteStelle', valueCoding: { system: CS.aufnahmegrund4, code: code.substring(3, 4) } }
      ]
    }
  ];
}

/** PV1-3 (or PV1-6) point of care / room / bed as Station, Zimmer and Bettenstellplatz. */
function locations(ctx: MapContext, pv1: Segment, status: 'active' | 'completed', field?: number): EncounterLocation[] {
  var pl = readPl(pv1.rep(field || 3));
  var out: EncounterLocation[] = [];
  var sys = ctx.cfg.systems.location;
  if (pl.pointOfCare) {
    out.push(loc(sys, pl.pointOfCare, pl.pointOfCare, 'wa', status));
    if (pl.room) {
      out.push(loc(sys, pl.pointOfCare + '-' + pl.room, 'Zimmer ' + pl.room, 'ro', status));
      if (pl.bed) out.push(loc(sys, pl.pointOfCare + '-' + pl.room + '-' + pl.bed, 'Bett ' + pl.bed, 'bd', status));
    }
  }
  return out;
}

function loc(system: string, value: string, display: string, type: 'wa' | 'ro' | 'bd', status: 'active' | 'completed'): EncounterLocation {
  var displays = { wa: 'Ward', ro: 'Room', bd: 'Bed' };
  return {
    location: { identifier: { system: system, value: value }, display: display },
    status: status,
    physicalType: { coding: [{ system: CS.locationPhysicalType, code: type, display: displays[type] }] }
  };
}
