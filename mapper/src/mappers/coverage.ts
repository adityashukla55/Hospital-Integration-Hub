import type { Account, Coverage, HumanName, Identifier } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS, PROFILE, SID } from '../fhir/profiles';
import { readCx } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { toFhirDate } from '../util/time';
import { issue, MapContext } from './context';
import { kvnrIdentifier } from './patient';

var KVNR = /^[A-Z][0-9]{9}$/;

export interface MappedCoverage {
  resource: Coverage;
  identifier: Identifier;
  kvnr?: string;
}

/**
 * IN1 to ISiKVersicherungsverhaeltnisGesetzlich. Interface contract:
 * IN1-15 carries the Versicherungsart (GKV, PKV, SEL, ...), IN1-3 the
 * insurer's IK number, IN1-36 the Krankenversichertennummer.
 * Only statutory (GKV) coverage is mapped in this version.
 */
export function mapCoverage(
  ctx: MapContext,
  in1: Segment,
  patientFullUrl: string,
  patientNumber: string,
  patientName: HumanName | undefined,
  patientKvnr: string | undefined
): MappedCoverage | undefined {
  var art = in1.get(15) || 'GKV';
  if (art !== 'GKV') {
    issue(ctx, 'information', 'COVERAGE_SKIPPED', 'Versicherungsart "' + art + '" is not mapped (only GKV)', 'IN1-15');
    return undefined;
  }
  var iknr = in1.rep(3) ? readCx(in1.rep(3) as NonNullable<ReturnType<Segment['rep']>>).id : '';
  if (!/^\d{9}$/.test(iknr)) throw new MappingError('INVALID_VALUE', 'insurer IK number must have 9 digits, got "' + iknr + '"', 'IN1-3');
  var insurerName = in1.get(4, 1);
  if (!insurerName) throw new MappingError('MISSING_REQUIRED_FIELD', 'insurer name is required (Coverage.payor.display)', 'IN1-4');

  var kvnr = in1.get(36);
  if (kvnr && !KVNR.test(kvnr)) {
    issue(ctx, 'warning', 'INVALID_KVNR', 'IN1-36 "' + kvnr + '" is not a valid KVNR and was ignored', 'IN1-36');
    kvnr = '';
  }
  kvnr = kvnr || patientKvnr || '';

  var identifier: Identifier = { system: ctx.cfg.systems.coverage, value: patientNumber + '-' + iknr };
  var relationship = in1.get(17, 1);
  var selfInsured = !relationship || relationship === 'SEL' || relationship === '01';

  var coverage: Coverage = {
    resourceType: 'Coverage',
    meta: { profile: [PROFILE.coverageGkv] },
    identifier: [identifier],
    status: 'active',
    type: { coding: [{ system: CS.versicherungsart, code: 'GKV', display: 'gesetzliche Krankenversicherung' }] },
    beneficiary: { reference: patientFullUrl },
    payor: [
      {
        identifier: { type: { coding: [{ system: CS.v2_0203, code: 'XX' }] }, system: SID.iknr, value: iknr },
        display: insurerName
      }
    ],
    period: { start: toFhirDate(in1.get(12)), end: toFhirDate(in1.get(13)) }
  };
  if (selfInsured && kvnr) {
    coverage.subscriber = {
      reference: patientFullUrl,
      identifier: kvnrIdentifier(kvnr),
      display: patientName ? [(patientName.given || []).join(' '), patientName.family].join(' ') : undefined
    };
  }
  return { resource: coverage, identifier: identifier, kvnr: kvnr || undefined };
}

/** ISiKAbrechnungsfall keyed by the Fallnummer. */
export function mapAccount(ctx: MapContext, fallnummer: string, patientFullUrl: string, coverageFullUrl?: string): { resource: Account; identifier: Identifier } {
  var identifier: Identifier = {
    type: { coding: [{ system: CS.v2_0203, code: 'AN' }] },
    system: ctx.cfg.systems.account,
    value: fallnummer
  };
  var account: Account = {
    resourceType: 'Account',
    meta: { profile: [PROFILE.account] },
    identifier: [identifier],
    status: 'active',
    subject: [{ reference: patientFullUrl }],
    coverage: coverageFullUrl ? [{ coverage: { reference: coverageFullUrl }, priority: 1 }] : undefined
  };
  return { resource: account, identifier: identifier };
}
