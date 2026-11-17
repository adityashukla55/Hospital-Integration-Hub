/**
 * Deterministic, non-cryptographic hashing used for bundle fullUrls and for
 * client-assigned ids (Provenance, Binary). Determinism is what makes replays
 * idempotent and golden files stable.
 *
 * Performance matters here: a message needs 10-15 hashes and Rhino's
 * arithmetic is slow. The FNV prime 0x01000193 is 2^24 + 403, so
 * `h * prime mod 2^32` is computed exactly as `(h << 24) + h * 403` (both
 * terms stay below 2^53), and the four lanes share one pass over the input.
 */

function mul32(a: number, b: number): number {
  var ah = (a >>> 16) & 0xffff;
  var al = a & 0xffff;
  var bh = (b >>> 16) & 0xffff;
  var bl = b & 0xffff;
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) >>> 0;
}

/** murmur3 fmix32 finaliser */
function fmix(h: number): number {
  h ^= h >>> 16;
  h = mul32(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = mul32(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

var SEEDS = [0x9e3779b9, 0x7f4a7c15, 0x94d049bb, 0x2545f491];

/** Four independent FNV-1a lanes over the UTF-16 code units (low byte, then high byte). */
function lanes(input: string): number[] {
  var h0 = (0x811c9dc5 ^ SEEDS[0]) >>> 0;
  var h1 = (0x811c9dc5 ^ SEEDS[1]) >>> 0;
  var h2 = (0x811c9dc5 ^ SEEDS[2]) >>> 0;
  var h3 = (0x811c9dc5 ^ SEEDS[3]) >>> 0;
  for (var i = 0; i < input.length; i++) {
    var c = input.charCodeAt(i);
    var lo = c & 0xff;
    var hi = c >>> 8;
    h0 = ((h0 ^ lo) >>> 0);
    h0 = ((h0 << 24) + h0 * 403) >>> 0;
    h0 = ((h0 ^ hi) >>> 0);
    h0 = ((h0 << 24) + h0 * 403) >>> 0;
    h1 = ((h1 ^ lo) >>> 0);
    h1 = ((h1 << 24) + h1 * 403) >>> 0;
    h1 = ((h1 ^ hi) >>> 0);
    h1 = ((h1 << 24) + h1 * 403) >>> 0;
    h2 = ((h2 ^ lo) >>> 0);
    h2 = ((h2 << 24) + h2 * 403) >>> 0;
    h2 = ((h2 ^ hi) >>> 0);
    h2 = ((h2 << 24) + h2 * 403) >>> 0;
    h3 = ((h3 ^ lo) >>> 0);
    h3 = ((h3 << 24) + h3 * 403) >>> 0;
    h3 = ((h3 ^ hi) >>> 0);
    h3 = ((h3 << 24) + h3 * 403) >>> 0;
  }
  return [fmix(h0), fmix(h1), fmix(h2), fmix(h3)];
}

/** FNV-1a over UTF-16 code units, with a seed mixed into the offset basis (single lane). */
export function fnv1a32(input: string, seed: number): number {
  var h = (0x811c9dc5 ^ seed) >>> 0;
  for (var i = 0; i < input.length; i++) {
    var c = input.charCodeAt(i);
    h = ((h ^ (c & 0xff)) >>> 0);
    h = ((h << 24) + h * 403) >>> 0;
    h = ((h ^ (c >>> 8)) >>> 0);
    h = ((h << 24) + h * 403) >>> 0;
  }
  return fmix(h);
}

function hex8(n: number): string {
  var s = (n >>> 0).toString(16);
  while (s.length < 8) s = '0' + s;
  return s;
}

/** 128-bit hex digest (32 characters). */
export function hash128(input: string): string {
  var l = lanes(input);
  return hex8(l[0]) + hex8(l[1]) + hex8(l[2]) + hex8(l[3]);
}

/** RFC 9562 version-8 (custom) UUID derived from the input. */
export function deterministicUuid(input: string): string {
  var h = hash128(input);
  var variant = ((parseInt(h.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return (
    h.substring(0, 8) +
    '-' +
    h.substring(8, 12) +
    '-8' +
    h.substring(13, 16) +
    '-' +
    variant +
    h.substring(17, 20) +
    '-' +
    h.substring(20, 32)
  );
}

/** A FHIR id ([A-Za-z0-9\-\.]{1,64}) with a readable prefix. */
export function deterministicId(prefix: string, input: string): string {
  return prefix + '-' + hash128(input);
}
