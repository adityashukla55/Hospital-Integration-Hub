import type { Bundle, BundleEntry, Identifier, Reference, Resource } from 'fhir/r4';
import { compact, padLeft } from '../util/lang';
import { deterministicUuid } from '../util/hash';

/** Escapes a token value for FHIR search ("\", "|", "," and "$"). */
export function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/,/g, '\\,').replace(/\$/g, '\\$');
}

/** "identifier=system|value", URL-encoded. */
export function identifierQuery(identifier: Identifier): string {
  return 'identifier=' + encodeURIComponent((identifier.system || '') + '|' + escapeSearchValue(identifier.value || ''));
}

/**
 * Conditional URL for a resource keyed by its business identifier. Patients
 * exclude inactive records so that a merged (retired) patient no longer
 * matches its old Patientennummer: see the A40 handling in delivery/merge.ts.
 */
export function conditionalUrl(resourceType: string, identifier: Identifier): string {
  var url = resourceType + '?' + identifierQuery(identifier);
  if (resourceType === 'Patient') url += '&active:not=false';
  return url;
}

/** A conditional reference resolved by the FHIR server inside the transaction. */
export function conditionalReference(resourceType: string, identifier: Identifier): Reference {
  return { reference: conditionalUrl(resourceType, identifier) };
}

export type EntryKind = 'upsert' | 'create-if-missing' | 'put';

export interface HubEntryMeta {
  kind: EntryKind;
  resourceType: string;
  identifier?: Identifier;
  /** Patient/Encounter entries are read-reconciled-written by the delivery step */
  stateful?: boolean;
}

/**
 * Builds a FHIR transaction. Every resource gets a deterministic urn:uuid
 * fullUrl so other entries can reference it and golden files stay stable.
 * fullUrls only need to be unique within the bundle, so the message key is
 * hashed once and each entry appends its position (hashing is expensive in
 * Rhino; ids that must be stable across replays use deterministicId).
 */
export class TransactionBuilder {
  private entries: BundleEntry[];
  private meta: HubEntryMeta[];
  private keyToFullUrl: { [key: string]: string };
  private prefix: string;
  private counter: number;

  constructor(seed: string) {
    // "xxxxxxxx-xxxx-8xxx-yxxx-" (version 8, RFC variant) + 12 hex digits per entry
    this.prefix = deterministicUuid(seed).substring(0, 24);
    this.counter = 0;
    this.entries = [];
    this.meta = [];
    this.keyToFullUrl = {};
  }

  private fullUrlFor(_key: string): string {
    this.counter++;
    return 'urn:uuid:' + this.prefix + padLeft(this.counter.toString(16), 12);
  }

  /** Conditional update: PUT Type?identifier=... (creates when absent). */
  upsert(resource: Resource, identifier: Identifier, options?: { stateful?: boolean }): string {
    var key = resource.resourceType + '|' + identifier.system + '|' + identifier.value;
    var existing = this.keyToFullUrl[key];
    if (existing) {
      this.replaceResource(existing, resource);
      return existing;
    }
    var fullUrl = this.fullUrlFor(key);
    this.keyToFullUrl[key] = fullUrl;
    this.entries.push({
      fullUrl: fullUrl,
      resource: compact(resource),
      request: { method: 'PUT', url: conditionalUrl(resource.resourceType, identifier) }
    });
    this.meta.push({ kind: 'upsert', resourceType: resource.resourceType, identifier: identifier, stateful: !!(options && options.stateful) });
    return fullUrl;
  }

  /** Conditional create: POST with If-None-Exist (never overwrites existing data). */
  createIfMissing(resource: Resource, identifier: Identifier): string {
    var key = resource.resourceType + '|' + identifier.system + '|' + identifier.value;
    var existing = this.keyToFullUrl[key];
    if (existing) return existing;
    var fullUrl = this.fullUrlFor(key);
    this.keyToFullUrl[key] = fullUrl;
    var q = conditionalUrl(resource.resourceType, identifier);
    this.entries.push({
      fullUrl: fullUrl,
      resource: compact(resource),
      request: { method: 'POST', url: resource.resourceType, ifNoneExist: q.substring(q.indexOf('?') + 1) }
    });
    this.meta.push({ kind: 'create-if-missing', resourceType: resource.resourceType, identifier: identifier });
    return fullUrl;
  }

  /** PUT with a client-assigned id (deterministic ids: Provenance, Binary). */
  put(resource: Resource & { id: string }): string {
    var key = resource.resourceType + '/' + resource.id;
    var existing = this.keyToFullUrl[key];
    if (existing) {
      this.replaceResource(existing, resource);
      return existing;
    }
    var fullUrl = this.fullUrlFor(key);
    this.keyToFullUrl[key] = fullUrl;
    this.entries.push({ fullUrl: fullUrl, resource: compact(resource), request: { method: 'PUT', url: key } });
    this.meta.push({ kind: 'put', resourceType: resource.resourceType });
    return fullUrl;
  }

  fullUrlOf(resourceType: string, identifier: Identifier): string | undefined {
    return this.keyToFullUrl[resourceType + '|' + identifier.system + '|' + identifier.value];
  }

  private replaceResource(fullUrl: string, resource: Resource): void {
    for (var i = 0; i < this.entries.length; i++) {
      if (this.entries[i].fullUrl === fullUrl) this.entries[i].resource = compact(resource);
    }
  }

  allFullUrls(): string[] {
    var out: string[] = [];
    for (var i = 0; i < this.entries.length; i++) out.push(this.entries[i].fullUrl as string);
    return out;
  }

  build(): { bundle: Bundle; entryMeta: HubEntryMeta[] } {
    return {
      bundle: { resourceType: 'Bundle', type: 'transaction', entry: this.entries },
      entryMeta: this.meta
    };
  }
}

export function ref(fullUrl: string): Reference {
  return { reference: fullUrl };
}
