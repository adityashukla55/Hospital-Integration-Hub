import type { Address, ContactPoint, Extension, HumanName, Identifier, Patient } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS, EXT, PROFILE, SID } from '../fhir/profiles';
import { readCx, readXad, readXpn, readXtn, Xad, Xpn } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { COUNTRY, GENDER } from '../terminology/v2tables';
import { contains, trim } from '../util/lang';
import { toFhirDate, toFhirDateTime } from '../util/time';
import { issue, MapContext } from './context';

var KVNR = /^[A-Z][0-9]{9}$/;

export interface MappedPatient {
  resource: Patient;
  /** the hospital Patientennummer: business key for conditional updates */
  identifier: Identifier;
  kvnr?: string;
}

export function patientNumberIdentifier(ctx: MapContext, value: string): Identifier {
  return {
    use: 'usual',
    type: { coding: [{ system: CS.v2_0203, code: 'MR' }] },
    system: ctx.cfg.systems.patient,
    value: value
  };
}

export function kvnrIdentifier(value: string): Identifier {
  return {
    use: 'official',
    type: { coding: [{ system: CS.identifierTypeDe, code: 'KVZ10' }] },
    system: SID.kvid10,
    value: value
  };
}

/** Maps PID to an ISiKPatient. */
export function mapPatient(ctx: MapContext, pid: Segment): MappedPatient {
  var identifiers: Identifier[] = [];
  var patientNumber = '';
  var kvnr = '';

  var cxs = pid.reps(3);
  for (var i = 0; i < cxs.length; i++) {
    var cx = readCx(cxs[i]);
    if (!cx.id) continue;
    var loc = 'PID-3[' + (i + 1) + ']';
    if (cx.typeCode === 'KVZ10' || cx.typeCode === 'GKV') {
      if (KVNR.test(cx.id)) kvnr = cx.id;
      else issue(ctx, 'warning', 'INVALID_KVNR', 'Krankenversichertennummer "' + cx.id + '" does not match the 10-character KVNR format and was dropped', loc);
      continue;
    }
    var ownAuthority = !cx.assigningAuthority || contains(ctx.cfg.patientAssigningAuthorities, cx.assigningAuthority);
    if ((cx.typeCode === 'PI' || cx.typeCode === 'MR' || cx.typeCode === 'PN' || cx.typeCode === '') && ownAuthority && !patientNumber) {
      patientNumber = cx.id;
      continue;
    }
    issue(ctx, 'information', 'IDENTIFIER_SKIPPED', 'identifier type "' + cx.typeCode + '" from "' + cx.assigningAuthority + '" is not mapped', loc);
  }
  if (!patientNumber) {
    throw new MappingError('MISSING_REQUIRED_FIELD', 'no hospital patient number (CX-5 PI/MR from an own assigning authority) found', 'PID-3');
  }
  var pn = patientNumberIdentifier(ctx, patientNumber);
  identifiers.push(pn);
  if (kvnr) identifiers.push(kvnrIdentifier(kvnr));

  var patient: Patient = {
    resourceType: 'Patient',
    meta: { profile: [PROFILE.patient] },
    identifier: identifiers,
    active: true,
    name: mapNames(ctx, pid),
    telecom: mapTelecom(pid),
    gender: undefined,
    birthDate: toFhirDate(pid.get(7, 1)),
    address: mapAddresses(ctx, pid)
  };

  var sex = pid.get(8);
  var g = GENDER[sex];
  if (!g) {
    if (sex) issue(ctx, 'warning', 'UNMAPPED_CODE', 'administrative sex "' + sex + '" mapped to unknown', 'PID-8');
    patient.gender = 'unknown';
  } else {
    patient.gender = g.gender;
    if (g.amtlich) {
      (patient as Patient & { _gender?: { extension: Extension[] } })._gender = {
        extension: [{ url: EXT.genderAmtlich, valueCoding: { system: CS.genderAmtlich, code: g.amtlich.code, display: g.amtlich.display } }]
      };
    }
  }

  if (!patient.birthDate) {
    // ISiK requires birthDate; an unknown date is expressed with data-absent-reason.
    (patient as Patient & { _birthDate?: { extension: Extension[] } })._birthDate = {
      extension: [{ url: EXT.dataAbsentReason, valueCode: 'unknown' }]
    };
    issue(ctx, 'warning', 'MISSING_BIRTHDATE', 'birth date missing or invalid; marked as unknown', 'PID-7');
  }

  if (pid.get(30) === 'Y' || pid.has(29)) {
    var deceasedAt = toFhirDateTime(pid.get(29, 1), ctx.cfg.timezone);
    if (deceasedAt) patient.deceasedDateTime = deceasedAt;
    else patient.deceasedBoolean = true;
  }

  return { resource: patient, identifier: pn, kvnr: kvnr || undefined };
}

function mapNames(ctx: MapContext, pid: Segment): HumanName[] {
  var reps = pid.reps(5);
  var official: HumanName | undefined;
  var maiden: HumanName | undefined;
  for (var i = 0; i < reps.length; i++) {
    var x = readXpn(reps[i]);
    var t = x.nameType || 'L';
    if ((t === 'L' || t === 'D') && !official) official = buildName(x, 'official');
    else if ((t === 'B' || t === 'M') && !maiden) maiden = buildName(x, 'maiden');
  }
  // Mothers' maiden name in PID-6 is not the patient's Geburtsname, so it is not mapped.
  if (!official || !official.family || !official.given || !official.given.length) {
    throw new MappingError('MISSING_REQUIRED_FIELD', 'legal name with family and given name is required', 'PID-5');
  }
  var out: HumanName[] = [official];
  if (maiden && maiden.family) {
    // ISiK Geburtsname: family only, no given names or prefixes
    out.push({ use: 'maiden', family: maiden.family, _family: (maiden as HumanName & { _family?: unknown })._family } as HumanName);
  }
  return out;
}

function buildName(x: Xpn, use: 'official' | 'maiden'): HumanName {
  var name: HumanName & { _family?: { extension: Extension[] }; _prefix?: Array<{ extension: Extension[] } | null> } = { use: use };
  var familyExt: Extension[] = [];
  if (x.ownPrefix) {
    // FN with subcomponents: surname & own surname prefix & own surname (e.g. "von Müller&von&Müller")
    var own = x.ownName || x.family;
    name.family = trim(x.ownPrefix + ' ' + own);
    familyExt.push({ url: EXT.humannameOwnPrefix, valueString: x.ownPrefix });
    familyExt.push({ url: EXT.humannameOwnName, valueString: own });
  } else {
    name.family = x.family;
    if (x.family) familyExt.push({ url: EXT.humannameOwnName, valueString: x.family });
  }
  if (familyExt.length) name._family = { extension: familyExt };
  var given: string[] = [];
  if (x.given) given.push(x.given);
  if (x.middle) {
    var parts = x.middle.split(' ');
    for (var i = 0; i < parts.length; i++) if (parts[i]) given.push(parts[i]);
  }
  if (given.length) name.given = given;
  var academic = x.degree || (/^(Dr|Prof)/.test(x.prefix) ? x.prefix : '');
  if (academic && use === 'official') {
    name.prefix = [academic];
    name._prefix = [{ extension: [{ url: EXT.prefixQualifier, valueCode: 'AC' }] }];
  }
  return name;
}

function mapTelecom(pid: Segment): ContactPoint[] {
  var out: ContactPoint[] = [];
  addTelecom(out, pid, 13, 'home');
  addTelecom(out, pid, 14, 'work');
  return out;
}

function addTelecom(out: ContactPoint[], pid: Segment, field: number, defaultUse: ContactPoint['use']): void {
  var reps = pid.reps(field);
  for (var i = 0; i < reps.length; i++) {
    var x = readXtn(reps[i]);
    var system: ContactPoint['system'] = 'phone';
    var value = '';
    if (x.equipment === 'Internet' || x.equipment === 'X.400' || x.useCode === 'NET') {
      system = 'email';
      value = x.email || x.legacy;
    } else {
      if (x.equipment === 'FX') system = 'fax';
      value = x.unformatted || joinPhone(x.countryCode, x.areaCode, x.localNumber) || x.legacy;
    }
    if (!value) continue;
    var use: ContactPoint['use'] = defaultUse;
    if (x.equipment === 'CP') use = 'mobile';
    out.push({ system: system, value: value, use: use });
  }
}

function joinPhone(country: string, area: string, local: string): string {
  if (!local) return '';
  var parts: string[] = [];
  if (country) parts.push('+' + country.replace(/^\+/, ''));
  if (area) parts.push(country ? area.replace(/^0/, '') : area);
  parts.push(local);
  return parts.join(' ');
}

function mapAddresses(ctx: MapContext, pid: Segment): Address[] {
  var out: Address[] = [];
  var reps = pid.reps(11);
  for (var i = 0; i < reps.length; i++) {
    var a = mapAddress(ctx, readXad(reps[i]), 'PID-11[' + (i + 1) + ']');
    if (a) out.push(a);
  }
  return out;
}

export function mapAddress(ctx: MapContext, x: Xad, location: string): Address | undefined {
  var country = normalizeCountry(x.country);
  var isPostBox = /^(Postfach|PF)\b/i.test(x.street);
  var lineText = x.street || trim(x.streetName + ' ' + x.houseNumber);
  if (!lineText || !x.city || !x.zip || !country) {
    issue(ctx, 'warning', 'INCOMPLETE_ADDRESS', 'address needs street, city, postal code and country for ISiK; skipped', location);
    return undefined;
  }
  var lineExt: Extension[] = [];
  if (isPostBox) {
    lineExt.push({ url: EXT.adxpPostBox, valueString: lineText.replace(/^(Postfach|PF)\s*/i, '') });
  } else {
    var street = x.streetName;
    var house = x.houseNumber;
    if (!street) {
      // split "Musterstraße 12a" into street name and house number
      var m = /^(.*\D)\s+(\d+\s*[a-zA-Z]?(?:[-\/]\d+[a-zA-Z]?)?)$/.exec(lineText);
      if (m) {
        street = m[1];
        house = m[2];
      }
    }
    if (street) lineExt.push({ url: EXT.adxpStreetName, valueString: street });
    if (house) lineExt.push({ url: EXT.adxpHouseNumber, valueString: house });
  }
  var address: Address & { _line?: Array<{ extension: Extension[] }> } = {
    type: isPostBox ? 'postal' : 'both',
    use: x.type === 'B' || x.type === 'O' ? 'work' : 'home',
    line: [lineText],
    city: x.city,
    postalCode: x.zip,
    country: country
  };
  if (lineExt.length) address._line = [{ extension: lineExt }];
  if (x.other && !isPostBox) {
    address.line = [lineText, x.other];
    address._line = [{ extension: lineExt }, { extension: [{ url: EXT.adxpAdditionalLocator, valueString: x.other }] }];
  }
  return address;
}

function normalizeCountry(value: string): string {
  if (!value) return '';
  var v = value.toUpperCase();
  if (COUNTRY[v]) return COUNTRY[v];
  return /^[A-Z]{2}$/.test(v) ? v : '';
}
