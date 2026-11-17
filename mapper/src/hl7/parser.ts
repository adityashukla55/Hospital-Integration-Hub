import { MappingError } from '../errors';

/**
 * A small, dependency-free HL7 v2 ER7 parser.
 *
 * The engine could hand us its own E4X representation, but parsing the raw
 * message ourselves keeps the mapper independent of the engine and lets the
 * same code run in Node tests and in Rhino.
 */

export interface Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
  subcomponent: string;
}

/** One repetition of a field, split into components and subcomponents. */
export class Repetition {
  private comps: string[][];
  private delims: Delimiters;
  raw: string;

  constructor(raw: string, delims: Delimiters) {
    this.raw = raw;
    this.delims = delims;
    var parts = raw.split(delims.component);
    this.comps = [];
    for (var i = 0; i < parts.length; i++) this.comps.push(parts[i].split(delims.subcomponent));
  }

  /** Component (1-based), optionally a subcomponent (1-based); unescaped. */
  c(component: number, subcomponent?: number): string {
    var comp = this.comps[component - 1];
    if (!comp) return '';
    var v = comp[(subcomponent || 1) - 1];
    if (v === undefined) return '';
    return unescapeHl7(v, this.delims);
  }

  /** The whole component including subcomponent separators, unescaped per subcomponent. */
  component(component: number): string {
    var comp = this.comps[component - 1];
    if (!comp) return '';
    var out: string[] = [];
    for (var i = 0; i < comp.length; i++) out.push(unescapeHl7(comp[i], this.delims));
    return out.join(this.delims.subcomponent);
  }

  get componentCount(): number {
    return this.comps.length;
  }

  isEmpty(): boolean {
    return this.raw === '' || this.raw === '""';
  }
}

export class Segment {
  name: string;
  /** index in the message, 0-based (MSH is 0) */
  index: number;
  private fields: string[];
  private delims: Delimiters;

  constructor(name: string, fields: string[], delims: Delimiters, index: number) {
    this.name = name;
    this.fields = fields;
    this.delims = delims;
    this.index = index;
  }

  /** Raw field value (still escaped), '' when absent. */
  raw(field: number): string {
    var v = this.fields[field];
    return v === undefined ? '' : v;
  }

  has(field: number): boolean {
    var v = this.raw(field);
    return v !== '' && v !== '""';
  }

  reps(field: number): Repetition[] {
    var raw = this.raw(field);
    if (raw === '' || raw === '""') return [];
    if (this.name === 'MSH' && (field === 1 || field === 2)) return [new Repetition(raw, this.delims)];
    var parts = raw.split(this.delims.repetition);
    var out: Repetition[] = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] !== '') out.push(new Repetition(parts[i], this.delims));
    }
    return out;
  }

  rep(field: number, repetition?: number): Repetition | undefined {
    return this.reps(field)[(repetition || 1) - 1];
  }

  /** Shorthand: field, component, subcomponent, repetition (all 1-based). */
  get(field: number, component?: number, subcomponent?: number, repetition?: number): string {
    if (this.name === 'MSH' && (field === 1 || field === 2)) return this.raw(field);
    var r = this.rep(field, repetition);
    if (!r) return '';
    return r.c(component || 1, subcomponent);
  }

  /** "PID-3" style location for error messages. */
  loc(field?: number): string {
    return this.name + (field ? '-' + field : '');
  }

  get fieldCount(): number {
    return this.fields.length - 1;
  }
}

export interface MessageHeader {
  messageCode: string;
  triggerEvent: string;
  structure: string;
  controlId: string;
  version: string;
  processingId: string;
  sendingApplication: string;
  sendingFacility: string;
  receivingApplication: string;
  receivingFacility: string;
  dateTime: string;
}

export class Hl7Message {
  segments: Segment[];
  delimiters: Delimiters;
  header: MessageHeader;

  constructor(segments: Segment[], delimiters: Delimiters) {
    this.segments = segments;
    this.delimiters = delimiters;
    var msh = segments[0];
    this.header = {
      messageCode: msh.get(9, 1),
      triggerEvent: msh.get(9, 2),
      structure: msh.get(9, 3),
      controlId: msh.get(10),
      version: msh.get(12, 1),
      processingId: msh.get(11, 1),
      sendingApplication: msh.get(3, 1) || msh.get(3, 2),
      sendingFacility: msh.get(4, 1) || msh.get(4, 2),
      receivingApplication: msh.get(5, 1) || msh.get(5, 2),
      receivingFacility: msh.get(6, 1) || msh.get(6, 2),
      dateTime: msh.get(7, 1)
    };
  }

  segment(name: string): Segment | undefined {
    for (var i = 0; i < this.segments.length; i++) if (this.segments[i].name === name) return this.segments[i];
    return undefined;
  }

  all(name: string): Segment[] {
    var out: Segment[] = [];
    for (var i = 0; i < this.segments.length; i++) if (this.segments[i].name === name) out.push(this.segments[i]);
    return out;
  }

  /** Segment required by the mapping; throws a MISSING_REQUIRED_FIELD error otherwise. */
  require(name: string): Segment {
    var s = this.segment(name);
    if (!s) throw new MappingError('MISSING_REQUIRED_FIELD', 'segment ' + name + ' is required for ' + this.typeLabel(), name);
    return s;
  }

  typeLabel(): string {
    return this.header.messageCode + '^' + this.header.triggerEvent;
  }
}

/** Parses an ER7 message. Accepts \r, \n or \r\n segment terminators and MLLP framing. */
export function parseHl7(raw: string): Hl7Message {
  if (raw == null) throw new MappingError('PARSE_ERROR', 'empty message');
  var text = String(raw)
    .replace(/^[\u000b\s]+/, '')
    .replace(/[\u001c\s]+$/, '');
  if (text.substring(0, 3) !== 'MSH') throw new MappingError('PARSE_ERROR', 'message must start with an MSH segment');
  if (text.length < 8) throw new MappingError('PARSE_ERROR', 'MSH segment is truncated');

  var fieldSep = text.charAt(3);
  var encEnd = text.indexOf(fieldSep, 4);
  if (encEnd < 0) throw new MappingError('PARSE_ERROR', 'MSH-2 encoding characters are not terminated');
  var enc = text.substring(4, encEnd);
  if (enc.length < 4) throw new MappingError('PARSE_ERROR', 'MSH-2 must contain four encoding characters, got "' + enc + '"');

  var delims: Delimiters = {
    field: fieldSep,
    component: enc.charAt(0),
    repetition: enc.charAt(1),
    escape: enc.charAt(2),
    subcomponent: enc.charAt(3)
  };

  var lines = text.split(/\r\n|\r|\n/);
  var segments: Segment[] = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var name = line.substring(0, 3);
    if (!/^[A-Z][A-Z0-9]{2}$/.test(name)) {
      throw new MappingError('PARSE_ERROR', 'invalid segment name "' + name + '" on line ' + (i + 1));
    }
    var parts = line.split(fieldSep);
    var fields: string[];
    if (name === 'MSH') {
      // MSH-1 is the field separator itself, so field numbers shift by one.
      fields = ['MSH', fieldSep, enc];
      for (var j = 2; j < parts.length; j++) fields.push(parts[j]);
    } else {
      fields = parts;
    }
    segments.push(new Segment(name, fields, delims, segments.length));
  }
  if (segments.length === 0 || segments[0].name !== 'MSH') throw new MappingError('PARSE_ERROR', 'first segment must be MSH');
  if (!segments[0].get(9, 1)) throw new MappingError('PARSE_ERROR', 'MSH-9 message type is missing', 'MSH-9');
  return new Hl7Message(segments, delims);
}

/** Resolves HL7 escape sequences (\F\ \S\ \T\ \R\ \E\ \.br\ \Xhh\). */
export function unescapeHl7(value: string, d: Delimiters): string {
  var esc = d.escape;
  if (!esc || value.indexOf(esc) < 0) return value;
  var out = '';
  var i = 0;
  while (i < value.length) {
    var ch = value.charAt(i);
    if (ch !== esc) {
      out += ch;
      i++;
      continue;
    }
    var close = value.indexOf(esc, i + 1);
    if (close < 0) {
      out += value.substring(i);
      break;
    }
    var seq = value.substring(i + 1, close);
    out += decodeEscape(seq, d);
    i = close + 1;
  }
  return out;
}

function decodeEscape(seq: string, d: Delimiters): string {
  switch (seq) {
    case 'F':
      return d.field;
    case 'S':
      return d.component;
    case 'T':
      return d.subcomponent;
    case 'R':
      return d.repetition;
    case 'E':
      return d.escape;
    case '.br':
      return '\n';
    case 'H':
    case 'N':
      return '';
  }
  if (seq.charAt(0) === 'X' && /^X([0-9A-Fa-f]{2})+$/.test(seq)) {
    var bytes: number[] = [];
    for (var i = 1; i < seq.length; i += 2) bytes.push(parseInt(seq.substring(i, i + 2), 16));
    return decodeUtf8(bytes);
  }
  // Unknown escapes (formatting like \.sp\) are dropped rather than leaked into FHIR text.
  return '';
}

function decodeUtf8(bytes: number[]): string {
  var out = '';
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i++;
    } else if (b >= 0xc0 && b < 0xe0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      // Not valid UTF-8: treat as ISO-8859-1, which German KIS often send.
      out += String.fromCharCode(b);
      i++;
    }
  }
  return out;
}
