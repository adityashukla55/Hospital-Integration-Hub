import type { Bundle, Provenance, Reference } from 'fhir/r4';
import { DeepPartial, HubConfig, resolveConfig } from './config';
import { MappingError, MappingIssue } from './errors';
import { HubEntryMeta, TransactionBuilder } from './fhir/bundle';
import { CS } from './fhir/profiles';
import { Hl7Message, parseHl7 } from './hl7/parser';
import { ADT_EVENTS, mapAdt } from './mappers/adt';
import { DeliveryHints, MapContext } from './mappers/context';
import { mapDocument } from './mappers/documents';
import { mapOrders } from './mappers/orders';
import { mapResults } from './mappers/results';
import { Terminology } from './terminology/terminology';
import { contains } from './util/lang';
import { deterministicId } from './util/hash';
import { epochToInstant, toFhirDateTime } from './util/time';

export var HUB_VERSION = '0.1.0';

export interface MessageInfo {
  /** e.g. "ADT^A01" */
  type: string;
  code: string;
  event: string;
  structure: string;
  controlId: string;
  version: string;
  sendingApplication: string;
  sendingFacility: string;
  /** MSH-7 as FHIR dateTime */
  dateTime?: string;
  /** EVN-2 (or MSH-7) as FHIR dateTime */
  eventTime?: string;
  /** facility|application|control id: unique per sender, used for idempotent Provenance ids */
  key: string;
}

export interface MappingResult {
  hubVersion: string;
  message: MessageInfo;
  bundle: Bundle;
  entryMeta: HubEntryMeta[];
  hints: DeliveryHints;
  issues: MappingIssue[];
  /**
   * Patientennummer of the message's patient. The Deliver channel uses it as
   * its thread assignment variable: one patient's messages stay ordered on
   * one thread while different patients are delivered in parallel.
   */
  partitionKey?: string;
}

export type MapOutcome =
  | { status: 'MAPPED'; message: MessageInfo; result: MappingResult }
  | { status: 'IGNORED'; message: MessageInfo; reason: string };

export interface MapOptions {
  terminology: Terminology;
  config?: DeepPartial<HubConfig>;
  /** epoch milliseconds for Provenance.recorded (injected for reproducible output) */
  now?: number;
}

var SUPPORTED: { [code: string]: string[] } = {
  ADT: ADT_EVENTS,
  ORU: ['R01'],
  ORM: ['O01'],
  OML: ['O21'],
  MDM: ['T02', 'T10']
};

export function describeMessage(msg: Hl7Message, cfg: HubConfig): MessageInfo {
  var h = msg.header;
  var evn = msg.segment('EVN');
  var dateTime = toFhirDateTime(h.dateTime, cfg.timezone);
  var eventTime = (evn && toFhirDateTime(evn.get(2, 1), cfg.timezone)) || dateTime;
  return {
    type: h.messageCode + '^' + h.triggerEvent,
    code: h.messageCode,
    event: h.triggerEvent,
    structure: h.structure,
    controlId: h.controlId,
    version: h.version,
    sendingApplication: h.sendingApplication,
    sendingFacility: h.sendingFacility,
    dateTime: dateTime,
    eventTime: eventTime,
    key: h.sendingFacility + '|' + h.sendingApplication + '|' + h.controlId
  };
}

/**
 * Maps one HL7 v2 message to a FHIR transaction Bundle.
 * Pure apart from terminology lookups; throws MappingError on bad input.
 */
export function mapMessage(raw: string, options: MapOptions): MapOutcome {
  var cfg = resolveConfig(options.config);
  var msg = parseHl7(raw);
  var info = describeMessage(msg, cfg);
  if (!info.controlId) throw new MappingError('MISSING_REQUIRED_FIELD', 'message control id is required', 'MSH-10');
  if (!info.dateTime) throw new MappingError('MISSING_REQUIRED_FIELD', 'message date/time is required', 'MSH-7');

  var events = SUPPORTED[info.code];
  if (!events || !contains(events, info.event)) {
    return { status: 'IGNORED', message: info, reason: info.type + ' is not handled by the hub' };
  }

  var tx = new TransactionBuilder(info.key);
  var ctx: MapContext = {
    msg: msg,
    cfg: cfg,
    tx: tx,
    terminology: options.terminology,
    issues: [],
    hints: { statefulEncounters: [], requires: [], eventTime: info.eventTime },
    eventTime: info.eventTime
  };

  switch (info.code) {
    case 'ADT':
      mapAdt(ctx, info.event);
      break;
    case 'ORU':
      mapResults(ctx);
      break;
    case 'ORM':
    case 'OML':
      mapOrders(ctx);
      break;
    case 'MDM':
      mapDocument(ctx);
      break;
  }

  addProvenance(ctx, info, options.now === undefined ? new Date().getTime() : options.now);
  var built = tx.build();
  var partitionKey: string | undefined;
  for (var i = 0; i < built.entryMeta.length && !partitionKey; i++) {
    var m = built.entryMeta[i];
    if (m.resourceType === 'Patient' && m.identifier) partitionKey = m.identifier.value;
  }
  return {
    status: 'MAPPED',
    message: info,
    result: {
      hubVersion: HUB_VERSION,
      message: info,
      bundle: built.bundle,
      entryMeta: built.entryMeta,
      hints: ctx.hints,
      issues: ctx.issues,
      partitionKey: partitionKey
    }
  };
}

/**
 * One Provenance per message links every written resource to its source
 * message (lineage for audits and for the ops console). Its id is derived
 * from the message key, so replaying a message updates it instead of
 * creating a duplicate.
 */
function addProvenance(ctx: MapContext, info: MessageInfo, now: number): void {
  var urls = ctx.tx.allFullUrls();
  var targets: Reference[] = [];
  for (var i = 0; i < urls.length; i++) targets.push({ reference: urls[i] });
  var provenance: Provenance & { id: string } = {
    resourceType: 'Provenance',
    id: deterministicId('hl7v2', info.key),
    target: targets,
    occurredDateTime: info.eventTime,
    recorded: epochToInstant(now),
    activity: { coding: [{ system: CS.dataOperation, code: 'UPDATE', display: 'revise' }] },
    agent: [
      {
        type: { coding: [{ system: CS.provenanceAgentType, code: 'author', display: 'Author' }] },
        who: { display: info.sendingApplication + (info.sendingFacility ? ' (' + info.sendingFacility + ')' : '') }
      },
      {
        type: { coding: [{ system: CS.provenanceAgentType, code: 'assembler', display: 'Assembler' }] },
        who: { display: ctx.cfg.hubName + ' ' + HUB_VERSION }
      }
    ],
    entity: [
      {
        role: 'source',
        what: {
          identifier: { system: ctx.cfg.systems.messageControlId, value: info.key },
          display: info.type + ' ' + info.controlId
        }
      }
    ]
  };
  ctx.tx.put(provenance);
}
