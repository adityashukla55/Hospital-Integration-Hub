import type { Bundle, BundleEntry, DocumentReference, Encounter, Identifier, OperationOutcome, Patient, Provenance, Resource } from 'fhir/r4';
import { MappingIssue } from '../errors';
import { conditionalUrl, identifierQuery } from '../fhir/bundle';
import type { MappingResult } from '../map';
import { deepCopy } from '../util/lang';
import { deterministicUuid } from '../util/hash';
import { fhirDateTimeToEpoch } from '../util/time';
import { FhirClient, FhirResponse } from './client';
import { reconcileEncounter, reconcilePatient, rewriteReferences } from './reconcile';

export type DeliveryStatus = 'DELIVERED' | 'RETRY' | 'FAILED';

export interface DeliveryOutcome {
  status: DeliveryStatus;
  /** DELIVERED | DEPENDENCY_MISSING | VERSION_CONFLICT | SERVER_UNAVAILABLE | VALIDATION_FAILED | AMBIGUOUS_MATCH | REJECTED */
  code: string;
  message: string;
  httpStatus?: number;
  /** "Patient/123/_history/2" style locations from the transaction response */
  locations?: string[];
  /** error lines from the server's OperationOutcome */
  serverIssues?: string[];
  issues: MappingIssue[];
  /** the bundle that was (or would have been) sent */
  bundle?: Bundle;
}

/** Resources that can point at a patient, searched when a merge moves references. */
var PATIENT_REFERENCE_SEARCHES: Array<[string, string]> = [
  ['Encounter', 'subject'],
  ['Account', 'subject'],
  ['Coverage', 'beneficiary'],
  ['Coverage', 'subscriber'],
  ['Condition', 'subject'],
  ['Observation', 'subject'],
  ['DiagnosticReport', 'subject'],
  ['ServiceRequest', 'subject'],
  ['DocumentReference', 'subject']
];

class RetryableError {
  code: string;
  message: string;
  constructor(code: string, message: string) {
    this.code = code;
    this.message = message;
  }
}

/**
 * Sends a mapped message to the FHIR server.
 *
 * 1. preflight reads: resolve dependencies, reconcile stateful resources
 *    (Patient, Encounter) with their stored versions and switch them to
 *    versioned PUTs (If-Match) so concurrent writers cannot be overwritten;
 * 2. plan follow-up changes (A40 merge reference rewrite, T10 supersede);
 * 3. POST one atomic transaction and classify the result as delivered,
 *    retryable or failed (dead letter).
 */
export function deliver(result: MappingResult, client: FhirClient): DeliveryOutcome {
  var issues: MappingIssue[] = [];
  var bundle = deepCopy(result.bundle);
  try {
    checkDependencies(result, bundle, client);
    if (result.hints.statefulPatient) preparePatient(result, bundle, client, issues);
    for (var i = 0; i < result.hints.statefulEncounters.length; i++) prepareEncounter(result.hints.statefulEncounters[i], bundle, client, issues);
    if (result.hints.merge) planMerge(result, bundle, client, issues);
    if (result.hints.supersede) planSupersede(result.hints.supersede.identifier, bundle, client, issues);
  } catch (e) {
    if (e instanceof RetryableError) return { status: 'RETRY', code: e.code, message: e.message, issues: issues, bundle: bundle };
    throw e;
  }

  var res: FhirResponse;
  try {
    res = client.request('POST', '', JSON.stringify(bundle), { 'Content-Type': 'application/fhir+json', Prefer: 'return=minimal' });
  } catch (e) {
    return { status: 'RETRY', code: 'SERVER_UNAVAILABLE', message: 'transaction failed: ' + String(e), issues: issues, bundle: bundle };
  }
  return classify(res, issues, bundle);
}

function classify(res: FhirResponse, issues: MappingIssue[], bundle: Bundle): DeliveryOutcome {
  if (res.status >= 200 && res.status < 300) {
    var locations: string[] = [];
    try {
      var body = JSON.parse(res.body) as Bundle;
      var entries = body.entry || [];
      for (var i = 0; i < entries.length; i++) {
        var r = entries[i].response;
        if (r && r.location) locations.push(r.location);
      }
    } catch (e) {
      // a 2xx without a parseable bundle is still a success
    }
    return { status: 'DELIVERED', code: 'DELIVERED', message: 'transaction committed', httpStatus: res.status, locations: locations, issues: issues, bundle: bundle };
  }
  var serverIssues = operationOutcomeLines(res.body);
  var summary = serverIssues.length ? serverIssues.slice(0, 3).join('; ') : 'HTTP ' + res.status;
  var base = { httpStatus: res.status, serverIssues: serverIssues, issues: issues, bundle: bundle };
  if (res.status >= 400 && res.status < 500 && /timed out/i.test(serverIssues.join(' '))) {
    // HAPI's validator reports its own timeouts (e.g. regex evaluation under
    // CPU pressure) as validation errors; the message itself is fine.
    return merge(base, { status: 'RETRY' as DeliveryStatus, code: 'SERVER_BUSY', message: 'validator timed out: ' + summary });
  }
  if (res.status === 409) return merge(base, { status: 'RETRY' as DeliveryStatus, code: 'VERSION_CONFLICT', message: 'resource changed concurrently: ' + summary });
  if (res.status === 412) {
    if (/multiple resources match/i.test(summary)) {
      return merge(base, { status: 'FAILED' as DeliveryStatus, code: 'AMBIGUOUS_MATCH', message: 'conditional match is not unique: ' + summary });
    }
    return merge(base, { status: 'FAILED' as DeliveryStatus, code: 'VALIDATION_FAILED', message: summary });
  }
  if (res.status === 400 || res.status === 422) return merge(base, { status: 'FAILED' as DeliveryStatus, code: 'VALIDATION_FAILED', message: summary });
  if (res.status === 404 || res.status === 405 || res.status === 410) return merge(base, { status: 'FAILED' as DeliveryStatus, code: 'REJECTED', message: summary });
  // 401/403 (misconfiguration), 408, 429 and 5xx: the message is fine, the server is not
  return merge(base, { status: 'RETRY' as DeliveryStatus, code: 'SERVER_UNAVAILABLE', message: 'HTTP ' + res.status + ': ' + summary });
}

function merge(base: Partial<DeliveryOutcome>, extra: Pick<DeliveryOutcome, 'status' | 'code' | 'message'>): DeliveryOutcome {
  var out = deepCopy(base) as DeliveryOutcome;
  out.status = extra.status;
  out.code = extra.code;
  out.message = extra.message;
  return out;
}

export function operationOutcomeLines(body: string): string[] {
  var out: string[] = [];
  try {
    var oo = JSON.parse(body) as OperationOutcome;
    var list = oo.issue || [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (it.severity !== 'error' && it.severity !== 'fatal') continue;
      var where = (it.expression && it.expression[0]) || (it.location && it.location[0]) || '';
      out.push((it.diagnostics || (it.details && it.details.text) || it.code) + (where ? ' @ ' + where : ''));
    }
  } catch (e) {
    if (body) out.push(body.substring(0, 300));
  }
  return out;
}

// ---------------------------------------------------------------------------
// preflight

/**
 * Preflight reads must see the current state: HAPI reuses identical search
 * results for 60 s by default, which made a read-reconcile-write see "no
 * patient yet" and overwrite a merge alias (found in the end-to-end run).
 */
var NO_CACHE = { 'Cache-Control': 'no-cache' };

function get(client: FhirClient, path: string): FhirResponse {
  var res: FhirResponse;
  try {
    res = client.request('GET', path, undefined, NO_CACHE);
  } catch (e) {
    throw new RetryableError('SERVER_UNAVAILABLE', 'GET ' + path + ' failed: ' + String(e));
  }
  if (res.status >= 500 || res.status === 429 || res.status === 401 || res.status === 403) {
    throw new RetryableError('SERVER_UNAVAILABLE', 'GET ' + path + ' returned HTTP ' + res.status);
  }
  return res;
}

function searchAll<T extends Resource>(client: FhirClient, path: string): T[] {
  var out: T[] = [];
  var next: string | undefined = path;
  var pages = 0;
  while (next && pages < 50) {
    var res = get(client, next);
    if (res.status !== 200) break;
    var b = JSON.parse(res.body) as Bundle;
    var entries = b.entry || [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.resource && (!e.search || e.search.mode !== 'include')) out.push(e.resource as T);
    }
    next = undefined;
    var links = b.link || [];
    for (var l = 0; l < links.length; l++) if (links[l].relation === 'next') next = links[l].url;
    pages++;
  }
  return out;
}

function findOne<T extends Resource>(client: FhirClient, path: string): T | undefined {
  var found = searchAll<T>(client, path);
  return found.length ? found[0] : undefined;
}

function entryByFullUrl(bundle: Bundle, fullUrl: string): BundleEntry | undefined {
  var entries = bundle.entry || [];
  for (var i = 0; i < entries.length; i++) if (entries[i].fullUrl === fullUrl) return entries[i];
  return undefined;
}

function bundleWrites(bundle: Bundle, resourceType: string, identifier: Identifier): boolean {
  var entries = bundle.entry || [];
  var q = identifierQuery(identifier);
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (!e.resource || e.resource.resourceType !== resourceType || !e.request) continue;
    if (e.request.url.indexOf(q) >= 0 || (e.request.ifNoneExist && e.request.ifNoneExist.indexOf(q) >= 0)) return true;
  }
  return false;
}

/** Out-of-order arrival: results/documents that reference an Encounter wait until it exists. */
function checkDependencies(result: MappingResult, bundle: Bundle, client: FhirClient): void {
  var reqs = result.hints.requires;
  for (var i = 0; i < reqs.length; i++) {
    var r = reqs[i];
    if (bundleWrites(bundle, r.resourceType, r.identifier)) continue;
    var res = get(client, r.resourceType + '?' + identifierQuery(r.identifier) + '&_elements=id&_count=1');
    var total = 0;
    if (res.status === 200) {
      var b = JSON.parse(res.body) as Bundle;
      total = b.total !== undefined ? b.total : (b.entry || []).length;
    }
    if (!total) {
      throw new RetryableError('DEPENDENCY_MISSING', r.resourceType + ' ' + r.identifier.value + ' (' + r.location + ') does not exist yet');
    }
  }
}

/** fullUrl for an entry that updates an existing server resource */
function existingFullUrl(res: Resource): string {
  return 'urn:uuid:' + deterministicUuid('existing|' + res.resourceType + '/' + res.id);
}

function versionedPut(entry: BundleEntry, resource: Resource, current: Resource): void {
  entry.resource = resource;
  entry.request = { method: 'PUT', url: current.resourceType + '/' + current.id };
  if (current.meta && current.meta.versionId) entry.request.ifMatch = 'W/"' + current.meta.versionId + '"';
}

function preparePatient(result: MappingResult, bundle: Bundle, client: FhirClient, issues: MappingIssue[]): void {
  var hint = result.hints.statefulPatient as NonNullable<MappingResult['hints']['statefulPatient']>;
  var entry = entryByFullUrl(bundle, hint.fullUrl);
  if (!entry) return;
  var current = findOne<Patient>(client, conditionalUrl('Patient', hint.identifier));
  if (!current) return; // new patient: the conditional PUT creates it

  var lastApplied: number | undefined;
  var prov = findOne<Provenance>(client, 'Provenance?target=Patient/' + current.id + '&_sort=-when&_count=1&_elements=occurred');
  if (prov) lastApplied = fhirDateTimeToEpoch(prov.occurredDateTime);
  var rec = reconcilePatient(current, entry.resource as Patient, hint.identifier, fhirDateTimeToEpoch(result.hints.eventTime), lastApplied);
  for (var i = 0; i < rec.notes.length; i++) {
    issues.push({ severity: 'warning', code: rec.notes[i], message: noteText(rec.notes[i]), location: 'Patient/' + current.id });
  }
  versionedPut(entry, rec.resource, current);
}

function prepareEncounter(hint: { fullUrl: string; identifier: Identifier }, bundle: Bundle, client: FhirClient, issues: MappingIssue[]): void {
  var entry = entryByFullUrl(bundle, hint.fullUrl);
  if (!entry) return;
  var current = findOne<Encounter>(client, conditionalUrl('Encounter', hint.identifier));
  if (!current) return;
  var rec = reconcileEncounter(current, entry.resource as Encounter);
  for (var i = 0; i < rec.notes.length; i++) {
    issues.push({ severity: 'warning', code: rec.notes[i], message: noteText(rec.notes[i]), location: 'Encounter/' + current.id });
  }
  versionedPut(entry, rec.resource, current);
}

/**
 * ADT^A40: retire the old patient (active=false, link replaced-by) and move
 * every reference to it onto the survivor, all in the same transaction with
 * If-Match on each rewritten resource.
 */
function planMerge(result: MappingResult, bundle: Bundle, client: FhirClient, issues: MappingIssue[]): void {
  var m = result.hints.merge as NonNullable<MappingResult['hints']['merge']>;
  var retired = findOne<Patient>(client, 'Patient?' + identifierQuery(m.retiredIdentifier));
  if (!retired) {
    issues.push({ severity: 'warning', code: 'MERGE_RETIRED_UNKNOWN', message: 'retired patient ' + m.retiredIdentifier.value + ' does not exist; only the survivor was updated' });
    return;
  }
  var survivorEntry = entryByFullUrl(bundle, m.survivorFullUrl) as BundleEntry;
  var survivor = survivorEntry.resource as Patient;
  if (retired.id && survivor.id === retired.id) {
    issues.push({ severity: 'warning', code: 'MERGE_SAME_RECORD', message: 'retired and surviving numbers already resolve to the same Patient' });
    return;
  }
  var retiredRef = 'Patient/' + retired.id;
  var alreadyMerged = retired.active === false && !!retired.link && retired.link.length > 0;

  var moved = 0;
  for (var i = 0; i < PATIENT_REFERENCE_SEARCHES.length; i++) {
    var type = PATIENT_REFERENCE_SEARCHES[i][0];
    var param = PATIENT_REFERENCE_SEARCHES[i][1];
    var found = searchAll<Resource>(client, type + '?' + param + '=' + retiredRef + '&_count=100');
    for (var f = 0; f < found.length; f++) {
      var res = found[f];
      if (entryAlreadyPlanned(bundle, res)) continue;
      var rw = rewriteReferences(res, retiredRef, m.survivorFullUrl);
      if (!rw.count) continue;
      bundle.entry = bundle.entry || [];
      var e: BundleEntry = { fullUrl: existingFullUrl(res) };
      versionedPut(e, rw.resource, res);
      bundle.entry.push(e);
      moved++;
    }
  }

  if (!alreadyMerged) {
    var retiredUpdate = deepCopy(retired);
    retiredUpdate.active = false;
    retiredUpdate.link = [{ other: { reference: m.survivorFullUrl }, type: 'replaced-by' }];
    var re: BundleEntry = { fullUrl: existingFullUrl(retired) };
    versionedPut(re, retiredUpdate, retired);
    (bundle.entry as BundleEntry[]).push(re);
  }
  survivor.link = survivor.link || [];
  var hasLink = false;
  for (var l = 0; l < survivor.link.length; l++) if (survivor.link[l].other.reference === retiredRef) hasLink = true;
  if (!hasLink) survivor.link.push({ other: { reference: retiredRef }, type: 'replaces' });

  issues.push({
    severity: 'information',
    code: alreadyMerged ? 'MERGE_REPLAYED' : 'MERGE_PLANNED',
    message: 'merge ' + m.retiredIdentifier.value + ' -> ' + m.survivorIdentifier.value + ': ' + moved + ' reference(s) moved'
  });
}

function entryAlreadyPlanned(bundle: Bundle, res: Resource): boolean {
  var entries = bundle.entry || [];
  for (var i = 0; i < entries.length; i++) {
    var r = entries[i].request;
    if (r && r.url === res.resourceType + '/' + res.id) return true;
  }
  return false;
}

/** MDM^T10: the replaced document becomes "superseded". */
function planSupersede(identifier: Identifier, bundle: Bundle, client: FhirClient, issues: MappingIssue[]): void {
  var parent = findOne<DocumentReference>(client, 'DocumentReference?' + identifierQuery(identifier));
  if (!parent) {
    issues.push({ severity: 'warning', code: 'PARENT_DOCUMENT_UNKNOWN', message: 'replaced document ' + identifier.value + ' not found' });
    return;
  }
  if (parent.status === 'superseded') return;
  var updated = deepCopy(parent);
  updated.status = 'superseded';
  var e: BundleEntry = { fullUrl: existingFullUrl(parent) };
  versionedPut(e, updated, parent);
  (bundle.entry as BundleEntry[]).push(e);
}

function noteText(code: string): string {
  switch (code) {
    case 'MERGED_PATIENT_ALIAS':
      return 'message uses a patient number retired by a merge; the surviving patient was not overwritten';
    case 'OUT_OF_ORDER_STALE_DEMOGRAPHICS':
      return 'message is older than the last applied event; stored demographics kept';
    case 'KEPT_MERGE_ALIAS':
      return 'merge alias identifier kept on the patient';
  }
  if (code.indexOf('OUT_OF_ORDER_STATUS_KEPT_') === 0) return 'event arrived after a later status; stored status and period end kept';
  return code;
}
