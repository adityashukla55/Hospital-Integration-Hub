import type { Encounter, EncounterLocation, Identifier, Patient, Reference } from 'fhir/r4';
import { deepCopy } from '../util/lang';

/**
 * Pure functions that merge an incoming resource with the version already
 * stored on the server. They encode the hub's rules for out-of-order and
 * replayed messages; the delivery step does the I/O around them.
 */

export interface ReconcileResult<T> {
  resource: T;
  /** issue codes explaining what was kept from the stored version */
  notes: string[];
  /** true when the incoming message did not change anything */
  unchanged: boolean;
}

function sameIdentifier(a: Identifier, b: Identifier): boolean {
  return a.system === b.system && a.value === b.value;
}

/**
 * Patient rules:
 *  - a message that still uses a number retired by a merge (now an "old"
 *    identifier on the survivor) must not overwrite the survivor;
 *  - a message older than the last applied one (by event time) must not
 *    overwrite newer demographics;
 *  - otherwise the message wins, but merge aliases ("old" identifiers),
 *    identifiers the message does not know (e.g. KVNR) and links are kept.
 */
export function reconcilePatient(
  current: Patient,
  incoming: Patient,
  incomingKey: Identifier,
  incomingEventEpoch: number | undefined,
  lastAppliedEpoch: number | undefined
): ReconcileResult<Patient> {
  var notes: string[] = [];
  var currentIds = current.identifier || [];
  for (var i = 0; i < currentIds.length; i++) {
    if (currentIds[i].use === 'old' && sameIdentifier(currentIds[i], incomingKey)) {
      notes.push('MERGED_PATIENT_ALIAS');
      return { resource: deepCopy(current), notes: notes, unchanged: true };
    }
  }
  if (incomingEventEpoch !== undefined && lastAppliedEpoch !== undefined && incomingEventEpoch < lastAppliedEpoch) {
    notes.push('OUT_OF_ORDER_STALE_DEMOGRAPHICS');
    return { resource: deepCopy(current), notes: notes, unchanged: true };
  }

  var merged = deepCopy(incoming);
  merged.id = current.id;
  var ids = merged.identifier || [];
  var incomingSystems: { [system: string]: boolean } = {};
  var incomingValues: { [key: string]: boolean } = {};
  for (var m = 0; m < ids.length; m++) {
    incomingSystems[ids[m].system || ''] = true;
    incomingValues[(ids[m].system || '') + '|' + ids[m].value] = true;
  }
  for (var c = 0; c < currentIds.length; c++) {
    var cid = currentIds[c];
    if (incomingValues[(cid.system || '') + '|' + cid.value]) continue;
    if (cid.use === 'old') {
      // merge alias: only the hub writes these, so a KIS message never removes them
      ids.push(cid);
      notes.push('KEPT_MERGE_ALIAS');
    } else if (!incomingSystems[cid.system || '']) {
      // a system the message did not send at all (e.g. KVNR missing in this A08): keep it
      ids.push(cid);
    }
    // same system, different value: the message is authoritative (e.g. corrected KVNR)
  }
  merged.identifier = ids;
  if (current.link && current.link.length) {
    merged.link = mergeLinks(current.link, merged.link || []);
  }
  return { resource: merged, notes: notes, unchanged: false };
}

function mergeLinks(current: NonNullable<Patient['link']>, incoming: NonNullable<Patient['link']>): NonNullable<Patient['link']> {
  var out = deepCopy(current);
  for (var i = 0; i < incoming.length; i++) {
    var dup = false;
    for (var j = 0; j < out.length; j++) {
      if (out[j].other.reference === incoming[i].other.reference && out[j].type === incoming[i].type) dup = true;
    }
    if (!dup) out.push(incoming[i]);
  }
  return out;
}

var STATUS_RANK: { [status: string]: number } = {
  planned: 0,
  arrived: 1,
  triaged: 1,
  'in-progress': 1,
  onleave: 1,
  finished: 2,
  cancelled: 3,
  'entered-in-error': 3,
  unknown: -1
};

/**
 * Encounter rules:
 *  - status only moves forward (planned -> in-progress -> finished); an
 *    admit, transfer or update arriving after the discharge keeps the
 *    discharge (cancel events like A13 would be needed to reopen);
 *  - locations no longer reported are kept as "completed" history;
 *  - diagnoses, account, admit/discharge details survive messages that
 *    do not carry them.
 */
export function reconcileEncounter(current: Encounter, incoming: Encounter): ReconcileResult<Encounter> {
  var notes: string[] = [];
  var merged = deepCopy(incoming);
  merged.id = current.id;

  var cr = STATUS_RANK[current.status];
  var ir = STATUS_RANK[incoming.status];
  if (cr !== undefined && ir !== undefined && cr > ir) {
    merged.status = current.status;
    notes.push('OUT_OF_ORDER_STATUS_KEPT_' + current.status.toUpperCase().replace(/-/g, '_'));
    if (current.period && current.period.end) {
      merged.period = merged.period || {};
      merged.period.end = current.period.end;
    }
  }
  if (current.period && current.period.start && (!merged.period || !merged.period.start)) {
    merged.period = merged.period || {};
    merged.period.start = current.period.start;
  }

  merged.location = mergeLocations(current.location || [], merged.location || [], merged.status === 'finished');
  if ((!merged.diagnosis || !merged.diagnosis.length) && current.diagnosis && current.diagnosis.length) merged.diagnosis = current.diagnosis;
  if ((!merged.account || !merged.account.length) && current.account) merged.account = current.account;
  if (!merged.extension && current.extension) merged.extension = current.extension;
  if (current.hospitalization) {
    merged.hospitalization = merged.hospitalization || {};
    if (!merged.hospitalization.admitSource && current.hospitalization.admitSource) merged.hospitalization.admitSource = current.hospitalization.admitSource;
    if (!merged.hospitalization.dischargeDisposition && current.hospitalization.dischargeDisposition) {
      merged.hospitalization.dischargeDisposition = current.hospitalization.dischargeDisposition;
    }
  }
  if (!merged.serviceType && current.serviceType) merged.serviceType = current.serviceType;
  return { resource: merged, notes: notes, unchanged: false };
}

function locationKey(l: EncounterLocation): string {
  var id = l.location.identifier;
  return id ? (id.system || '') + '|' + (id.value || '') : l.location.reference || l.location.display || '';
}

function mergeLocations(current: EncounterLocation[], incoming: EncounterLocation[], finished: boolean): EncounterLocation[] {
  var out: EncounterLocation[] = [];
  var seen: { [key: string]: boolean } = {};
  for (var i = 0; i < incoming.length; i++) {
    var l = deepCopy(incoming[i]);
    if (finished) l.status = 'completed';
    seen[locationKey(l)] = true;
    out.push(l);
  }
  for (var j = 0; j < current.length; j++) {
    var key = locationKey(current[j]);
    if (seen[key]) continue;
    var old = deepCopy(current[j]);
    old.status = 'completed';
    seen[key] = true;
    out.push(old);
  }
  return out;
}

/** Replaces every reference to `from` (e.g. "Patient/123") anywhere in the resource. */
export function rewriteReferences<T>(resource: T, from: string, to: string): { resource: T; count: number } {
  var copy = deepCopy(resource);
  var count = 0;
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    if (Object.prototype.toString.call(node) === '[object Array]') {
      var arr = node as unknown[];
      for (var i = 0; i < arr.length; i++) walk(arr[i]);
      return;
    }
    var obj = node as { [k: string]: unknown };
    if (typeof obj.reference === 'string' && stripBase(obj.reference as string) === from) {
      (obj as Reference).reference = to;
      count++;
    }
    for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) walk(obj[k]);
  }
  walk(copy);
  return { resource: copy, count: count };
}

function stripBase(reference: string): string {
  var m = /([A-Za-z]+\/[A-Za-z0-9\-\.]{1,64})(\/_history\/[^\/]+)?$/.exec(reference);
  return m ? m[1] : reference;
}
