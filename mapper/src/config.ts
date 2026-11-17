import { CENTRAL_EUROPE, TimezoneRule } from './util/time';

/**
 * Site configuration. Everything that differs between hospitals lives here:
 * identifier namespaces, the hospital's IK number, ConceptMap canonicals and
 * the timezone for messages that arrive without an offset.
 */
export interface HubConfig {
  facility: {
    /** Institutionskennzeichen of the hospital (9 digits) */
    iknr: string;
    name: string;
  };
  systems: {
    patient: string;
    encounter: string;
    account: string;
    coverage: string;
    condition: string;
    observation: string;
    diagnosticReport: string;
    placerOrder: string;
    fillerOrder: string;
    specimen: string;
    document: string;
    location: string;
    messageControlId: string;
    /** code systems for the KIS-local codes that arrive in v2 messages */
    localLabCodes: string;
    localUnits: string;
    localDocumentTypes: string;
  };
  conceptMaps: {
    labToLoinc: string;
    unitsToUcum: string;
    documentTypeToKdl: string;
    kdlToXdsType: string;
    kdlToXdsClass: string;
  };
  /** HL7 v2 assigning authorities (PID-3.4) that identify the hospital's own patient numbers */
  patientAssigningAuthorities: string[];
  timezone: TimezoneRule;
  /** ICD-10-GM version used when DG1-3.7 does not say */
  icd10gmVersion: string;
  documentLanguage: string;
  /** name written into Provenance.agent */
  hubName: string;
}

var BASE = 'https://fhir.klinikum-musterstadt.example';

export var DEFAULT_CONFIG: HubConfig = {
  facility: {
    iknr: '261101015',
    name: 'Klinikum Musterstadt'
  },
  systems: {
    patient: BASE + '/sid/patientennummer',
    encounter: BASE + '/sid/aufnahmenummer',
    account: BASE + '/sid/abrechnungsnummer',
    coverage: BASE + '/sid/versicherungsverhaeltnis',
    condition: BASE + '/sid/diagnose',
    observation: BASE + '/sid/laborbefund-observation',
    diagnosticReport: BASE + '/sid/laborbefund',
    placerOrder: BASE + '/sid/auftragsnummer-anforderer',
    fillerOrder: BASE + '/sid/auftragsnummer-labor',
    specimen: BASE + '/sid/probe',
    document: BASE + '/sid/dokument',
    location: BASE + '/sid/standort',
    messageControlId: BASE + '/sid/hl7v2-nachricht',
    localLabCodes: BASE + '/CodeSystem/labor-lokal',
    localUnits: BASE + '/CodeSystem/einheiten-lokal',
    localDocumentTypes: BASE + '/CodeSystem/dokumenttyp-lokal'
  },
  conceptMaps: {
    labToLoinc: BASE + '/ConceptMap/labor-lokal-zu-loinc',
    unitsToUcum: BASE + '/ConceptMap/einheiten-lokal-zu-ucum',
    documentTypeToKdl: BASE + '/ConceptMap/dokumenttyp-lokal-zu-kdl',
    kdlToXdsType: 'http://dvmd.de/fhir/ConceptMap/kdl-ihe-typecode',
    kdlToXdsClass: 'http://dvmd.de/fhir/ConceptMap/kdl-ihe-classcode'
  },
  patientAssigningAuthorities: ['KLINIKUM', 'KIS'],
  timezone: CENTRAL_EUROPE,
  icd10gmVersion: '2026',
  documentLanguage: 'de-DE',
  hubName: 'Hospital Integration Hub'
};

/** Shallow-merges a partial site config over the defaults (two levels deep). */
export function resolveConfig(partial?: DeepPartial<HubConfig>): HubConfig {
  var out = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as HubConfig;
  if (!partial) return out;
  var p = partial as { [k: string]: unknown };
  var o = out as unknown as { [k: string]: unknown };
  for (var k in p) {
    if (!Object.prototype.hasOwnProperty.call(p, k) || p[k] === undefined) continue;
    var v = p[k];
    if (v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]' && o[k] && typeof o[k] === 'object') {
      var target = o[k] as { [k: string]: unknown };
      var src = v as { [k: string]: unknown };
      for (var k2 in src) if (Object.prototype.hasOwnProperty.call(src, k2) && src[k2] !== undefined) target[k2] = src[k2];
    } else {
      o[k] = v;
    }
  }
  return out;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };
