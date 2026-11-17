import { padLeft } from './lang';

/**
 * HL7 v2 DTM / TS values: YYYY[MM[DD[HH[MM[SS[.S[S[S[S]]]]]]]]][+/-ZZZZ]
 *
 * FHIR requires a timezone offset on every dateTime that carries a time, but
 * many KIS send local wall-clock times without one. The configured timezone
 * rule fills the gap; for Germany that is Central European Time with EU
 * daylight-saving rules.
 */

export interface Hl7Time {
  year: string;
  month?: string;
  day?: string;
  hour?: string;
  minute?: string;
  second?: string;
  fraction?: string;
  /** "+01:00" style, only when the message carried an offset */
  offset?: string;
}

export type TimezoneRule =
  | { kind: 'fixed'; offsetMinutes: number }
  | { kind: 'eu-dst'; standardOffsetMinutes: number };

/** Europe/Berlin, Europe/Vienna, Europe/Zurich, ... */
export var CENTRAL_EUROPE: TimezoneRule = { kind: 'eu-dst', standardOffsetMinutes: 60 };

var DTM = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.(\d{1,4}))?([+-]\d{4})?$/;

export function parseHl7Time(value: string | undefined): Hl7Time | null {
  if (!value) return null;
  var m = DTM.exec(value);
  if (!m) return null;
  var t: Hl7Time = { year: m[1] };
  if (m[2]) t.month = m[2];
  if (m[3]) t.day = m[3];
  if (m[4]) t.hour = m[4];
  if (m[5]) t.minute = m[5];
  if (m[6]) t.second = m[6];
  if (m[7]) t.fraction = m[7];
  if (m[8]) t.offset = m[8].substring(0, 3) + ':' + m[8].substring(3);
  if (!isPlausible(t)) return null;
  return t;
}

function isPlausible(t: Hl7Time): boolean {
  if (t.month && (+t.month < 1 || +t.month > 12)) return false;
  if (t.day && (+t.day < 1 || +t.day > 31)) return false;
  if (t.hour && +t.hour > 23) return false;
  if (t.minute && +t.minute > 59) return false;
  if (t.second && +t.second > 59) return false;
  return true;
}

/** FHIR date (YYYY, YYYY-MM or YYYY-MM-DD). */
export function toFhirDate(value: string | undefined): string | undefined {
  var t = parseHl7Time(value);
  if (!t) return undefined;
  var out = t.year;
  if (t.month) out += '-' + t.month;
  if (t.month && t.day) out += '-' + t.day;
  return out;
}

/**
 * FHIR dateTime. Date-only values stay date-only; values with a time get
 * seconds and a timezone offset.
 */
export function toFhirDateTime(value: string | undefined, tz: TimezoneRule): string | undefined {
  var t = parseHl7Time(value);
  if (!t) return undefined;
  if (!t.hour || !t.day || !t.month) return toFhirDate(value);
  return formatWithTime(t, tz);
}

/** FHIR instant: needs at least second precision and an offset. */
export function toFhirInstant(value: string | undefined, tz: TimezoneRule): string | undefined {
  var t = parseHl7Time(value);
  if (!t || !t.month || !t.day || !t.hour) return undefined;
  return formatWithTime(t, tz);
}

function formatWithTime(t: Hl7Time, tz: TimezoneRule): string {
  var minute = t.minute || '00';
  var second = t.second || '00';
  var local =
    t.year + '-' + t.month + '-' + t.day + 'T' + t.hour + ':' + minute + ':' + second + (t.fraction ? '.' + t.fraction : '');
  var offset = t.offset || formatOffset(offsetMinutesFor(tz, +t.year, +(t.month as string), +(t.day as string), +(t.hour as string), +minute));
  return local + offset;
}

export function formatOffset(minutes: number): string {
  var sign = minutes < 0 ? '-' : '+';
  var abs = Math.abs(minutes);
  return sign + padLeft(Math.floor(abs / 60), 2) + ':' + padLeft(abs % 60, 2);
}

/** Offset in minutes east of UTC for a local wall-clock time. */
export function offsetMinutesFor(tz: TimezoneRule, year: number, month: number, day: number, hour: number, minute: number): number {
  if (tz.kind === 'fixed') return tz.offsetMinutes;
  var std = tz.standardOffsetMinutes;
  // Interpret the wall clock as standard time first, then check whether that
  // UTC instant falls inside EU summer time (last Sunday in March 01:00 UTC
  // until last Sunday in October 01:00 UTC).
  var utc = Date.UTC(year, month - 1, day, hour, minute) - std * 60000;
  var start = lastSundayUtc(year, 2);
  var end = lastSundayUtc(year, 9);
  return utc >= start && utc < end ? std + 60 : std;
}

function lastSundayUtc(year: number, monthIndex: number): number {
  var lastDay = new Date(Date.UTC(year, monthIndex + 1, 0));
  var date = lastDay.getUTCDate() - lastDay.getUTCDay();
  return Date.UTC(year, monthIndex, date, 1, 0, 0);
}

/** Milliseconds since epoch for a FHIR dateTime/instant (offset aware). */
export function fhirDateTimeToEpoch(value: string | undefined): number | undefined {
  if (!value) return undefined;
  var m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/.exec(value);
  if (!m) return undefined;
  var ms = Date.UTC(+m[1], m[2] ? +m[2] - 1 : 0, m[3] ? +m[3] : 1, m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0);
  if (m[7]) ms += Math.round(+('0.' + m[7]) * 1000);
  if (m[8] && m[8] !== 'Z') {
    var sign = m[8].charAt(0) === '-' ? -1 : 1;
    ms -= sign * (+m[8].substring(1, 3) * 60 + +m[8].substring(4, 6)) * 60000;
  }
  return ms;
}

/** ISO instant in UTC for an epoch value (used for Provenance.recorded). */
export function epochToInstant(ms: number): string {
  var d = new Date(ms);
  return (
    d.getUTCFullYear() +
    '-' +
    padLeft(d.getUTCMonth() + 1, 2) +
    '-' +
    padLeft(d.getUTCDate(), 2) +
    'T' +
    padLeft(d.getUTCHours(), 2) +
    ':' +
    padLeft(d.getUTCMinutes(), 2) +
    ':' +
    padLeft(d.getUTCSeconds(), 2) +
    'Z'
  );
}
