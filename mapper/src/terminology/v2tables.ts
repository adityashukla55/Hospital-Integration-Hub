/**
 * Fixed HL7 v2 tables and German §301 code lists. These are defined by the
 * standards themselves (not by the hospital), so they live in code; anything
 * site-specific goes through ConceptMaps instead.
 */

export interface SimpleCoding {
  code: string;
  display: string;
}

/** HL7 table 0001 (administrative sex) plus German "D" (divers) and "X" (unbestimmt). */
export var GENDER: { [v2: string]: { gender: 'male' | 'female' | 'other' | 'unknown'; amtlich?: SimpleCoding } } = {
  M: { gender: 'male' },
  F: { gender: 'female' },
  W: { gender: 'female' },
  D: { gender: 'other', amtlich: { code: 'D', display: 'divers' } },
  X: { gender: 'other', amtlich: { code: 'X', display: 'unbestimmt' } },
  U: { gender: 'unknown' },
  A: { gender: 'unknown' },
  N: { gender: 'unknown' }
};

/** HL7 table 0004 (patient class) to the v3 ActCode classes allowed by EncounterClassDE. */
export var PATIENT_CLASS: { [v2: string]: SimpleCoding } = {
  I: { code: 'IMP', display: 'inpatient encounter' },
  B: { code: 'IMP', display: 'inpatient encounter' },
  O: { code: 'AMB', display: 'ambulatory' },
  E: { code: 'AMB', display: 'ambulatory' },
  R: { code: 'AMB', display: 'ambulatory' },
  P: { code: 'PRENC', display: 'pre-admission' }
};

/** §301 Aufnahmeanlass, sent in PV1-4 by German KIS. */
export var AUFNAHMEANLASS: { [code: string]: string } = {
  E: 'Einweisung durch einen Arzt',
  Z: 'Einweisung durch einen Zahnarzt',
  N: 'Notfall',
  R: 'Aufnahme nach vorausgehender Behandlung in einer Rehabilitationseinrichtung',
  V: 'Verlegung mit Behandlungsdauer im verlegenden Krankenhaus länger als 24 Stunden',
  A: 'Verlegung mit Behandlungsdauer im verlegenden Krankenhaus bis zu 24 Stunden',
  G: 'Geburt',
  B: 'Begleitperson oder mitaufgenommene Pflegekraft'
};

/** HL7 table 0085 (observation result status) to FHIR Observation.status. */
export var OBSERVATION_STATUS: { [v2: string]: string } = {
  F: 'final',
  C: 'corrected',
  P: 'preliminary',
  R: 'preliminary',
  S: 'preliminary',
  I: 'registered',
  X: 'cancelled',
  D: 'entered-in-error',
  W: 'entered-in-error',
  U: 'final'
};

/** HL7 table 0123 (result status, OBR-25) to FHIR DiagnosticReport.status. */
export var REPORT_STATUS: { [v2: string]: string } = {
  F: 'final',
  C: 'corrected',
  A: 'partial',
  P: 'preliminary',
  R: 'preliminary',
  S: 'partial',
  I: 'registered',
  O: 'registered',
  X: 'cancelled'
};

/** HL7 table 0078 (abnormal flags) to v3 ObservationInterpretation. */
export var INTERPRETATION: { [v2: string]: SimpleCoding } = {
  N: { code: 'N', display: 'Normal' },
  A: { code: 'A', display: 'Abnormal' },
  AA: { code: 'AA', display: 'Critical abnormal' },
  H: { code: 'H', display: 'High' },
  HH: { code: 'HH', display: 'Critical high' },
  L: { code: 'L', display: 'Low' },
  LL: { code: 'LL', display: 'Critical low' },
  '<': { code: '<', display: 'Off scale low' },
  '>': { code: '>', display: 'Off scale high' }
};

/** ORC-1 order control (table 0119) with ORC-5 order status (table 0038) to ServiceRequest.status. */
export function serviceRequestStatus(orderControl: string, orderStatus: string): string {
  switch (orderControl) {
    case 'CA':
    case 'OC':
    case 'CR':
    case 'DC':
    case 'OD':
    case 'DR':
      return 'revoked';
    case 'HD':
    case 'OH':
      return 'on-hold';
  }
  switch (orderStatus) {
    case 'CM':
      return 'completed';
    case 'CA':
    case 'DC':
      return 'revoked';
    case 'HD':
      return 'on-hold';
  }
  return 'active';
}

/** HL7 table 0027 priority (TQ1-9 / ORC-7.6) to ServiceRequest.priority. */
export var PRIORITY: { [v2: string]: string } = {
  S: 'stat',
  A: 'asap',
  R: 'routine',
  T: 'urgent'
};

/** TXA-17 document completion status (table 0271) to DocumentReference.docStatus. */
export var DOC_COMPLETION: { [v2: string]: string } = {
  AU: 'final',
  LA: 'final',
  DO: 'preliminary',
  IP: 'preliminary',
  IN: 'preliminary',
  PA: 'preliminary',
  DI: 'preliminary'
};

/** TXA-19 availability status (table 0275) to DocumentReference.status. */
export var DOC_AVAILABILITY: { [v2: string]: string } = {
  AV: 'current',
  UN: 'current',
  OB: 'superseded',
  CA: 'entered-in-error',
  AR: 'superseded',
  PU: 'current'
};

/** TXA-18 confidentiality (table 0272) to v3 Confidentiality (bound by ISiKConfidentialityCodes). */
export var CONFIDENTIALITY: { [v2: string]: SimpleCoding } = {
  V: { code: 'V', display: 'very restricted' },
  R: { code: 'R', display: 'restricted' },
  U: { code: 'N', display: 'normal' },
  UC: { code: 'N', display: 'normal' },
  N: { code: 'N', display: 'normal' }
};

/** KBV Diagnosesicherheit (A/G/V/Z). */
export var DIAGNOSESICHERHEIT: { [code: string]: { display: string; verification?: string; clinical?: string } } = {
  G: { display: 'gesicherte Diagnose', verification: 'confirmed', clinical: 'active' },
  V: { display: 'Verdacht auf / zum Ausschluss von', verification: 'provisional', clinical: 'active' },
  A: { display: 'ausgeschlossene Diagnose', verification: 'refuted' },
  Z: { display: 'Zustand nach der betreffenden Diagnose', verification: 'confirmed', clinical: 'resolved' }
};

/** KBV Seitenlokalisation (R/L/B). */
export var SEITENLOKALISATION: { [code: string]: string } = {
  R: 'rechts',
  L: 'links',
  B: 'beiderseits'
};

/** ISO 3166 country normalisation for XAD-6 (German KIS often send "D" or "DEU"). */
export var COUNTRY: { [v2: string]: string } = {
  D: 'DE',
  DEU: 'DE',
  GER: 'DE',
  A: 'AT',
  AUT: 'AT',
  CH: 'CH',
  CHE: 'CH',
  NL: 'NL',
  NLD: 'NL',
  F: 'FR',
  FRA: 'FR',
  PL: 'PL',
  POL: 'PL',
  I: 'IT',
  ITA: 'IT',
  TR: 'TR',
  TUR: 'TR',
  USA: 'US',
  CAN: 'CA',
  GBR: 'GB'
};
