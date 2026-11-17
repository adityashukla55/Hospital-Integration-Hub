/**
 * Public API of the mapper. In the engine this is exposed as the global
 * `HubMapper` (see scripts/bundle.ts); in Node it is a CommonJS module.
 */
export { DEFAULT_CONFIG, resolveConfig } from './config';
export type { HubConfig, DeepPartial } from './config';
export { MappingError, isMappingError } from './errors';
export type { MappingErrorCode, MappingIssue } from './errors';
export { parseHl7, unescapeHl7, Hl7Message, Segment, Repetition } from './hl7/parser';
export { mapMessage, describeMessage, HUB_VERSION } from './map';
export type { MapOptions, MapOutcome, MappingResult, MessageInfo } from './map';
export { InMemoryTerminology, FhirServerTerminology } from './terminology/terminology';
export type { Terminology, TranslatedCode } from './terminology/terminology';
export { deliver, operationOutcomeLines } from './delivery/deliver';
export type { DeliveryOutcome, DeliveryStatus } from './delivery/deliver';
export type { FhirClient, FhirResponse, HttpMethod } from './delivery/client';
export { reconcileEncounter, reconcilePatient, rewriteReferences } from './delivery/reconcile';
export { PROFILE, CS, SID, EXT } from './fhir/profiles';
export { CENTRAL_EUROPE, toFhirDateTime, toFhirDate, toFhirInstant, fhirDateTimeToEpoch } from './util/time';
export { deterministicId, deterministicUuid, hash128 } from './util/hash';

import { isMappingError } from './errors';
import { mapMessage, MapOptions, MapOutcome } from './map';
import { deliver, DeliveryOutcome } from './delivery/deliver';
import type { FhirClient } from './delivery/client';

/**
 * Convenience for the engine's Transform channel: never throws, always
 * returns a JSON-serialisable outcome the channel can route on.
 */
export function transform(
  raw: string,
  options: MapOptions
): MapOutcome | { status: 'ERROR'; code: string; message: string; location?: string; retryable: boolean } {
  try {
    return mapMessage(raw, options);
  } catch (e) {
    if (isMappingError(e)) return { status: 'ERROR', code: e.code, message: e.message, location: e.location, retryable: e.retryable };
    return { status: 'ERROR', code: 'INTERNAL_ERROR', message: String(e && (e as { stack?: string }).stack ? (e as { stack: string }).stack : e), retryable: false };
  }
}

/** Convenience for the engine's Deliver channel: never throws. */
export function deliverSafely(result: import('./map').MappingResult, client: FhirClient): DeliveryOutcome {
  try {
    return deliver(result, client);
  } catch (e) {
    return { status: 'FAILED', code: 'INTERNAL_ERROR', message: String(e), issues: [] };
  }
}
