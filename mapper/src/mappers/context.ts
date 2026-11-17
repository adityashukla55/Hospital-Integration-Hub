import type { Identifier } from 'fhir/r4';
import type { HubConfig } from '../config';
import type { MappingIssue } from '../errors';
import type { TransactionBuilder } from '../fhir/bundle';
import type { Hl7Message } from '../hl7/parser';
import type { Terminology } from '../terminology/terminology';

/**
 * Instructions for the delivery step: things that need the current server
 * state and therefore cannot be decided by the (pure) mapper.
 */
export interface DeliveryHints {
  /** ADT messages are authoritative for demographics: read-reconcile-write the Patient */
  statefulPatient?: { fullUrl: string; identifier: Identifier };
  /** Encounters whose status/location history must be reconciled with the stored version */
  statefulEncounters: Array<{ fullUrl: string; identifier: Identifier; event: string }>;
  /** Conditional references that must resolve before the bundle is sent (out-of-order arrival) */
  requires: Array<{ resourceType: string; identifier: Identifier; location: string }>;
  /** ADT^A40: retire the old patient and move its references */
  merge?: { survivorFullUrl: string; survivorIdentifier: Identifier; retiredIdentifier: Identifier };
  /** MDM^T10 / TXA-13: mark the parent document as superseded */
  supersede?: { identifier: Identifier };
  /** event time of the message (EVN-2, else MSH-7), used for out-of-order detection */
  eventTime?: string;
}

export interface MapContext {
  msg: Hl7Message;
  cfg: HubConfig;
  tx: TransactionBuilder;
  terminology: Terminology;
  issues: MappingIssue[];
  hints: DeliveryHints;
  /** FHIR dateTime of the triggering event */
  eventTime?: string;
}

export function issue(ctx: MapContext, severity: MappingIssue['severity'], code: string, message: string, location?: string): void {
  ctx.issues.push({ severity: severity, code: code, message: message, location: location });
}
