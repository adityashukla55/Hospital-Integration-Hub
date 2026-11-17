import { MappingError } from '../errors';
import type { FhirClient } from '../delivery/client';

/**
 * Terminology port. The mapper never hard-codes site-specific code mappings:
 * local lab codes, units and document types are translated through FHIR
 * ConceptMaps (terminology/ in the repo). In the engine the maps are queried
 * on the FHIR server with $translate; tests use the same files in memory.
 */
export interface TranslatedCode {
  system: string;
  code: string;
  display?: string;
  equivalence?: string;
}

export interface Terminology {
  translate(conceptMapUrl: string, system: string, code: string): TranslatedCode | null;
  /** display for a code, when the code system is known */
  lookupDisplay(system: string, code: string): string | null;
}

interface ConceptMapLike {
  url?: string;
  group?: Array<{
    source?: string;
    target?: string;
    element?: Array<{ code?: string; display?: string; target?: Array<{ code?: string; display?: string; equivalence?: string }> }>;
  }>;
}

interface CodeSystemLike {
  url?: string;
  concept?: Array<{ code: string; display?: string; concept?: CodeSystemLike['concept'] }>;
}

var NON_MATCH: { [k: string]: boolean } = { unmatched: true, disjoint: true };

/** ConceptMaps and CodeSystems held in memory (tests, offline use). */
export class InMemoryTerminology implements Terminology {
  private maps: { [url: string]: ConceptMapLike };
  private displays: { [key: string]: string };

  constructor(conceptMaps: ConceptMapLike[], codeSystems?: CodeSystemLike[]) {
    this.maps = {};
    this.displays = {};
    for (var i = 0; i < conceptMaps.length; i++) {
      var cm = conceptMaps[i];
      if (cm.url) this.maps[cm.url] = cm;
      // ConceptMaps carry source/target displays; use them as a display index too.
      var groups = cm.group || [];
      for (var g = 0; g < groups.length; g++) {
        var els = groups[g].element || [];
        for (var e = 0; e < els.length; e++) {
          var el = els[e];
          if (groups[g].source && el.code && el.display) this.displays[groups[g].source + '|' + el.code] = el.display;
          var targets = el.target || [];
          for (var t = 0; t < targets.length; t++) {
            var tg = targets[t];
            if (groups[g].target && tg.code && tg.display) this.displays[groups[g].target + '|' + tg.code] = tg.display;
          }
        }
      }
    }
    if (codeSystems) {
      for (var c = 0; c < codeSystems.length; c++) this.indexCodeSystem(codeSystems[c].url || '', codeSystems[c].concept || []);
    }
  }

  private indexCodeSystem(url: string, concepts: NonNullable<CodeSystemLike['concept']>): void {
    for (var i = 0; i < concepts.length; i++) {
      if (concepts[i].display) this.displays[url + '|' + concepts[i].code] = concepts[i].display as string;
      if (concepts[i].concept) this.indexCodeSystem(url, concepts[i].concept as NonNullable<CodeSystemLike['concept']>);
    }
  }

  translate(conceptMapUrl: string, system: string, code: string): TranslatedCode | null {
    var cm = this.maps[conceptMapUrl];
    if (!cm) throw new MappingError('TERMINOLOGY_UNAVAILABLE', 'ConceptMap ' + conceptMapUrl + ' is not loaded', undefined, true);
    var groups = cm.group || [];
    for (var g = 0; g < groups.length; g++) {
      if (groups[g].source && groups[g].source !== system) continue;
      var els = groups[g].element || [];
      for (var e = 0; e < els.length; e++) {
        if (els[e].code !== code) continue;
        var targets = els[e].target || [];
        for (var t = 0; t < targets.length; t++) {
          var tg = targets[t];
          if (tg.code && !NON_MATCH[tg.equivalence || '']) {
            return { system: groups[g].target || '', code: tg.code, display: tg.display, equivalence: tg.equivalence };
          }
        }
      }
    }
    return null;
  }

  lookupDisplay(system: string, code: string): string | null {
    var d = this.displays[system + '|' + code];
    return d === undefined ? null : d;
  }
}

/**
 * Uses ConceptMap/$translate and CodeSystem/$lookup on a FHIR terminology
 * server (HAPI in this stack). Results, including misses, are cached for the
 * lifetime of the instance; the engine keeps one instance per channel deploy.
 */
export class FhirServerTerminology implements Terminology {
  private client: FhirClient;
  private cache: { [key: string]: TranslatedCode | null };
  private displayCache: { [key: string]: string | null };

  constructor(client: FhirClient) {
    this.client = client;
    this.cache = {};
    this.displayCache = {};
  }

  translate(conceptMapUrl: string, system: string, code: string): TranslatedCode | null {
    var key = conceptMapUrl + '|' + system + '|' + code;
    if (Object.prototype.hasOwnProperty.call(this.cache, key)) return this.cache[key];
    var path =
      'ConceptMap/$translate?url=' +
      encodeURIComponent(conceptMapUrl) +
      '&system=' +
      encodeURIComponent(system) +
      '&code=' +
      encodeURIComponent(code);
    var res = this.call(path);
    var result: TranslatedCode | null = null;
    var params = res.parameter || [];
    for (var i = 0; i < params.length && !result; i++) {
      if (params[i].name !== 'match') continue;
      var parts = params[i].part || [];
      var concept: { system?: string; code?: string; display?: string } | undefined;
      var equivalence: string | undefined;
      for (var p = 0; p < parts.length; p++) {
        if (parts[p].name === 'concept') concept = parts[p].valueCoding;
        if (parts[p].name === 'equivalence' || parts[p].name === 'relationship') equivalence = parts[p].valueCode;
      }
      if (concept && concept.code && !NON_MATCH[equivalence || '']) {
        result = { system: concept.system || '', code: concept.code, display: concept.display, equivalence: equivalence };
      }
    }
    this.cache[key] = result;
    return result;
  }

  lookupDisplay(system: string, code: string): string | null {
    var key = system + '|' + code;
    if (Object.prototype.hasOwnProperty.call(this.displayCache, key)) return this.displayCache[key];
    var display: string | null = null;
    try {
      var res = this.call('CodeSystem/$lookup?system=' + encodeURIComponent(system) + '&code=' + encodeURIComponent(code));
      var params = res.parameter || [];
      for (var i = 0; i < params.length; i++) if (params[i].name === 'display') display = params[i].valueString || null;
    } catch (e) {
      display = null;
    }
    this.displayCache[key] = display;
    return display;
  }

  private call(path: string): TranslateParameters {
    var res;
    try {
      res = this.client.request('GET', path);
    } catch (e) {
      throw new MappingError('TERMINOLOGY_UNAVAILABLE', 'terminology server unreachable: ' + String(e), undefined, true);
    }
    if (res.status === 404) return {};
    if (res.status >= 500 || res.status === 429) {
      throw new MappingError('TERMINOLOGY_UNAVAILABLE', 'terminology server returned HTTP ' + res.status, undefined, true);
    }
    if (res.status >= 400) {
      // e.g. unknown ConceptMap or code system: treat as "no mapping"
      return {};
    }
    return JSON.parse(res.body) as TranslateParameters;
  }
}

interface TranslateParameters {
  parameter?: Array<{
    name: string;
    valueString?: string;
    valueBoolean?: boolean;
    part?: Array<{ name: string; valueCoding?: { system?: string; code?: string; display?: string }; valueCode?: string }>;
  }>;
}
