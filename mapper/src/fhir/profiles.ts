/**
 * ISiK Stufe 5 (package de.gematik.isik 5.2.0) profile canonicals and the
 * code systems / extensions the mapping writes. Values were taken from the
 * published StructureDefinitions, not from memory.
 */

var ISIK = 'https://gematik.de/fhir/isik/StructureDefinition/';

export var PROFILE = {
  patient: ISIK + 'ISiKPatient',
  encounter: ISIK + 'ISiKKontaktGesundheitseinrichtung',
  coverageGkv: ISIK + 'ISiKVersicherungsverhaeltnisGesetzlich',
  account: ISIK + 'ISiKAbrechnungsfall',
  condition: ISIK + 'ISiKDiagnose',
  labObservation: ISIK + 'ISiKLaboruntersuchung',
  documentReference: ISIK + 'ISiKDokumentenMetadaten',
  binary: ISIK + 'ISiKBinary'
};

export var SID = {
  kvid10: 'http://fhir.de/sid/gkv/kvid-10',
  iknr: 'http://fhir.de/sid/arge-ik/iknr',
  lanr: 'https://fhir.kbv.de/NamingSystem/KBV_NS_Base_ANR'
};

export var CS = {
  v2_0203: 'http://terminology.hl7.org/CodeSystem/v2-0203',
  v2_0074: 'http://terminology.hl7.org/CodeSystem/v2-0074',
  identifierTypeDe: 'http://fhir.de/CodeSystem/identifier-type-de-basis',
  v3ActCode: 'http://terminology.hl7.org/CodeSystem/v3-ActCode',
  kontaktebene: 'http://fhir.de/CodeSystem/Kontaktebene',
  kontaktart: 'http://fhir.de/CodeSystem/kontaktart-de',
  fachabteilung: 'http://fhir.de/CodeSystem/dkgev/Fachabteilungsschluessel',
  fachabteilungErweitert: 'http://fhir.de/CodeSystem/dkgev/Fachabteilungsschluessel-erweitert',
  // the ISiK/basisprofil code system URL really is spelled "dgkev" here
  aufnahmeanlass: 'http://fhir.de/CodeSystem/dgkev/Aufnahmeanlass',
  aufnahmegrund12: 'http://fhir.de/CodeSystem/dkgev/AufnahmegrundErsteUndZweiteStelle',
  aufnahmegrund3: 'http://fhir.de/CodeSystem/dkgev/AufnahmegrundDritteStelle',
  aufnahmegrund4: 'http://fhir.de/CodeSystem/dkgev/AufnahmegrundVierteStelle',
  entlassungsgrund12: 'http://fhir.de/CodeSystem/dkgev/EntlassungsgrundErsteUndZweiteStelle',
  entlassungsgrund3: 'http://fhir.de/CodeSystem/dkgev/EntlassungsgrundDritteStelle',
  locationPhysicalType: 'http://terminology.hl7.org/CodeSystem/location-physical-type',
  diagnoseTyp: 'http://fhir.de/CodeSystem/KontaktDiagnoseProzedur',
  versicherungsart: 'http://fhir.de/CodeSystem/versicherungsart-de-basis',
  genderAmtlich: 'http://fhir.de/CodeSystem/gender-amtlich-de',
  dataAbsentReason: 'http://terminology.hl7.org/CodeSystem/data-absent-reason',
  icd10gm: 'http://fhir.de/CodeSystem/bfarm/icd-10-gm',
  icdMehrfach: 'http://fhir.de/CodeSystem/icd-10-gm-mehrfachcodierungs-kennzeichen',
  icdSicherheit: 'https://fhir.kbv.de/CodeSystem/KBV_CS_SFHIR_ICD_DIAGNOSESICHERHEIT',
  icdSeite: 'https://fhir.kbv.de/CodeSystem/KBV_CS_SFHIR_ICD_SEITENLOKALISATION',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  conditionVerification: 'http://terminology.hl7.org/CodeSystem/condition-ver-status',
  observationCategory: 'http://terminology.hl7.org/CodeSystem/observation-category',
  interpretation: 'http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation',
  loinc: 'http://loinc.org',
  ucum: 'http://unitsofmeasure.org',
  snomed: 'http://snomed.info/sct',
  kdl: 'http://dvmd.de/fhir/CodeSystem/kdl',
  xdsType: 'http://ihe-d.de/CodeSystems/IHEXDStypeCode',
  xdsClass: 'http://ihe-d.de/CodeSystems/IHEXDSclassCode',
  formatCode: 'http://ihe.net/fhir/ihe.formatcode.fhir/CodeSystem/formatcode',
  facilityType: 'http://ihe-d.de/CodeSystems/PatientBezogenenGesundheitsversorgung',
  confidentiality: 'http://terminology.hl7.org/CodeSystem/v3-Confidentiality',
  dataOperation: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation',
  provenanceAgentType: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
  linkType: 'http://hl7.org/fhir/link-type'
};

export var EXT = {
  genderAmtlich: 'http://fhir.de/StructureDefinition/gender-amtlich-de',
  dataAbsentReason: 'http://hl7.org/fhir/StructureDefinition/data-absent-reason',
  humannameOwnPrefix: 'http://hl7.org/fhir/StructureDefinition/humanname-own-prefix',
  humannameOwnName: 'http://hl7.org/fhir/StructureDefinition/humanname-own-name',
  humannameNamenszusatz: 'http://fhir.de/StructureDefinition/humanname-namenszusatz',
  prefixQualifier: 'http://hl7.org/fhir/StructureDefinition/iso21090-EN-qualifier',
  adxpStreetName: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-streetName',
  adxpHouseNumber: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-houseNumber',
  adxpAdditionalLocator: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-additionalLocator',
  adxpPostBox: 'http://hl7.org/fhir/StructureDefinition/iso21090-ADXP-postBox',
  aufnahmegrund: 'http://fhir.de/StructureDefinition/Aufnahmegrund',
  entlassungsgrund: 'http://fhir.de/StructureDefinition/Entlassungsgrund',
  icdMehrfach: 'http://fhir.de/StructureDefinition/icd-10-gm-mehrfachcodierungs-kennzeichen',
  icdSicherheit: 'http://fhir.de/StructureDefinition/icd-10-gm-diagnosesicherheit',
  icdSeite: 'http://fhir.de/StructureDefinition/seitenlokalisation'
};
