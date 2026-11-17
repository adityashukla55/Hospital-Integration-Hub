import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hub from '../build/index.js';

export const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = join(here, '..', '..');

/** Fixed clock so Provenance.recorded is reproducible. */
export const NOW = Date.UTC(2026, 10, 17, 9, 0, 0);

function loadJsonDir(dir: string): any[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

/** The site ConceptMaps from terminology/ plus the DVMD subsets used offline. */
export function terminology(): hub.Terminology {
  const maps = [...loadJsonDir(join(repoRoot, 'terminology')), ...loadJsonDir(join(here, 'fixtures'))];
  return new hub.InMemoryTerminology(maps);
}

/** Joins segments with the HL7 segment terminator. */
export function hl7(...segments: string[]): string {
  return segments.join('\r');
}

export function map(raw: string): hub.MappingResult {
  const out = hub.mapMessage(raw, { terminology: terminology(), now: NOW });
  if (out.status !== 'MAPPED') throw new Error('expected MAPPED, got ' + out.status + ': ' + (out as { reason?: string }).reason);
  return out.result;
}

export function resources<T = any>(result: hub.MappingResult, type: string): T[] {
  return (result.bundle.entry || []).filter((e: any) => e.resource?.resourceType === type).map((e: any) => e.resource as T);
}

export function entries(result: hub.MappingResult, type: string): any[] {
  return (result.bundle.entry || []).filter((e: any) => e.resource?.resourceType === type);
}

export function expectMappingError(fn: () => unknown): hub.MappingError {
  try {
    fn();
  } catch (e) {
    if (hub.isMappingError(e)) return e;
    throw e;
  }
  throw new Error('expected a MappingError');
}

/**
 * Builds a segment from numbered fields so tests never depend on counting
 * pipes: seg('PV1', { 2: 'I', 19: 'F1' }) -> "PV1||I|...|F1".
 */
export function seg(name: string, fields: Record<number, string>): string {
  const max = Math.max(0, ...Object.keys(fields).map(Number));
  if (name === 'MSH') {
    const parts: string[] = [];
    for (let i = 3; i <= max; i++) parts.push(fields[i] ?? '');
    return 'MSH|^~\\&|' + parts.join('|');
  }
  const parts: string[] = [name];
  for (let i = 1; i <= max; i++) parts.push(fields[i] ?? '');
  return parts.join('|');
}

export const MSH = (type: string, id: string, ts = '20261117083000') =>
  seg('MSH', { 3: 'KIS', 4: 'KLINIKUM', 5: 'HUB', 6: 'KLINIKUM', 7: ts, 9: type, 10: id, 11: 'P', 12: '2.5', 15: 'AL', 16: 'NE', 18: '8859/1' });

export const EVN = (event: string, ts: string) => seg('EVN', { 1: event, 2: ts });

export const PID_MUELLER = seg('PID', {
  1: '1',
  3: '4711^^^KLINIKUM^PI~A123456780^^^GKV^KVZ10',
  5: 'von Müller&von&Müller^Anna^Maria^^^Dr.^L~Schmidt^^^^^^B',
  7: '19750312',
  8: 'F',
  11: 'Musterstraße 12a^^Musterstadt^^12345^D^H',
  13: '^PRN^PH^^49^30^1234567~^NET^Internet^anna.mueller@example.org'
});

export const pv1 = (extra: Record<number, string> = {}) =>
  seg('PV1', { 1: '1', 2: 'I', 3: 'STA3^304^2^KLINIKUM', 4: 'E', 10: '0100', 19: 'F2026000123', 44: '20261117080000', ...extra });

export const IN1_AOK = seg('IN1', { 1: '1', 2: 'GKV', 3: '108018007', 4: 'Muster-Krankenkasse', 15: 'GKV', 17: 'SEL', 36: 'A123456780' });
