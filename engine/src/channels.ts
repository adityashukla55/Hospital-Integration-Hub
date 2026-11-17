import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelReader, httpListener, javaScriptWriter, mllpListener, type ChannelDef, type CodeTemplateDef } from './xml.ts';

/**
 * The hub's channels. Pipeline (each hop has its own source queue, so the
 * KIS gets its ACK immediately and a slow FHIR server never blocks MLLP):
 *
 *   Hub 1 - Inbound   MLLP :6661 -> store raw message -> route by id
 *   Hub 2 - Transform v2 -> FHIR transaction (HubMapper) -> Deliver | Dead Letter
 *   Hub 3 - Deliver   preflight reads + transaction to HAPI, retry with back-off
 *   Hub 4 - Dead Letter  records failures (hub.dead_letter)
 *   Hub 5 - Replay    HTTP :8091/replay -> re-process stored messages
 */

const here = dirname(fileURLToPath(import.meta.url));
export const engineDir = join(here, '..');
const script = (name: string) => readFileSync(join(engineDir, 'scripts', name), 'utf8');

export const LIBRARY_ID = '7f3c2a10-0b6e-4d5b-9c11-2a4f0e6b8d01';
export const TEMPLATE_MAPPER_ID = '7f3c2a10-0b6e-4d5b-9c11-2a4f0e6b8d02';
export const TEMPLATE_RUNTIME_ID = '7f3c2a10-0b6e-4d5b-9c11-2a4f0e6b8d03';

export const CHANNEL_IDS = {
  inbound: 'b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0001',
  transform: 'b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0002',
  deliver: 'b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0003',
  deadLetter: 'b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0004',
  replay: 'b1d0c6a2-6f0a-4a71-9e55-3c0f1a2b0005'
};

export const MLLP_PORT = 6661;
export const REPLAY_PORT = 8091;
/** parallel delivery; messages of one patient always share a thread (hubPartition = Patientennummer) */
export const DELIVER_THREADS = 4;

export function channels(): ChannelDef[] {
  const common = { codeTemplateLibraryId: LIBRARY_ID, tags: ['hospital-integration-hub'] };
  return [
    {
      ...common,
      id: CHANNEL_IDS.inbound,
      name: 'Hub 1 - Inbound',
      description: 'MLLP listener for the KIS. ACKs before processing (store-and-forward), persists the raw HL7 v2 message in hub.message and routes it to Hub 2 - Transform.',
      source: mllpListener(MLLP_PORT),
      destinations: [javaScriptWriter(1, 'Store and route', script('inbound-store.js'))]
    },
    {
      ...common,
      id: CHANNEL_IDS.transform,
      name: 'Hub 2 - Transform',
      description: 'Maps HL7 v2 to an ISiK Stufe 5 FHIR transaction with HubMapper. Terminology lookups use ConceptMap/$translate on the FHIR server. Unsupported events are ignored, mapping errors are dead-lettered.',
      source: channelReader(),
      destinations: [javaScriptWriter(1, 'Map to FHIR', script('transform-map.js'), { enabled: true, retryIntervalMillis: 5000, rotate: true })]
    },
    {
      ...common,
      id: CHANNEL_IDS.deliver,
      name: 'Hub 3 - Deliver',
      description: 'Reconciles stateful resources with the server, sends one transaction per message to HAPI FHIR (validating against ISiK) and retries transient failures with exponential back-off. 4 queue threads, partitioned by patient number so per-patient order is kept.',
      source: channelReader(),
      destinations: [javaScriptWriter(1, 'Deliver to FHIR server', script('deliver-fhir.js'), { enabled: true, retryIntervalMillis: 1000, rotate: true, threads: DELIVER_THREADS, threadAssignmentVariable: 'hubPartition' })]
    },
    {
      ...common,
      id: CHANNEL_IDS.deadLetter,
      name: 'Hub 4 - Dead Letter',
      description: 'Records messages that could not be mapped or delivered (hub.dead_letter) and marks them FAILED. Replay them through Hub 5 - Replay or the ops console.',
      source: channelReader(),
      destinations: [javaScriptWriter(1, 'Record dead letter', script('deadletter-record.js'))]
    },
    {
      ...common,
      id: CHANNEL_IDS.replay,
      name: 'Hub 5 - Replay',
      description: 'HTTP API (internal network only): POST /replay {"messageIds":[...]} re-processes stored messages from the Transform stage as new hub.message rows.',
      source: httpListener(REPLAY_PORT, '/replay'),
      destinations: [javaScriptWriter(1, 'Replay messages', script('replay-request.js'))]
    }
  ];
}

export function codeTemplates(mapperBundle: string): CodeTemplateDef[] {
  return [
    {
      id: TEMPLATE_MAPPER_ID,
      name: 'HubMapper',
      description: 'HL7 v2 -> ISiK FHIR mapping and delivery library (generated from mapper/, do not edit in the Administrator).',
      code: mapperBundle
    },
    {
      id: TEMPLATE_RUNTIME_ID,
      name: 'Hub runtime',
      description: 'Adapters: configuration map, hub database (JDBC), FHIR HTTP client, terminology cache, routing helpers.',
      code: readFileSync(join(engineDir, 'code-templates', 'hub-runtime.js'), 'utf8')
    }
  ];
}
