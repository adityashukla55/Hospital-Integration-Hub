/**
 * Small ES5-only helpers. The mapper runs inside Rhino 1.7.13 (Open Integration
 * Engine), which lacks most ES2015 built-ins, so nothing here may rely on them.
 */

export function startsWith(value: string, prefix: string): boolean {
  return value.substring(0, prefix.length) === prefix;
}

export function endsWith(value: string, suffix: string): boolean {
  return suffix.length <= value.length && value.substring(value.length - suffix.length) === suffix;
}

export function padLeft(value: string | number, width: number, fill?: string): string {
  var s = String(value);
  var f = fill || '0';
  while (s.length < width) s = f + s;
  return s;
}

export function trim(value: string | undefined | null): string {
  return value == null ? '' : String(value).replace(/^\s+|\s+$/g, '');
}

export function find<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (var i = 0; i < items.length; i++) {
    if (predicate(items[i])) return items[i];
  }
  return undefined;
}

export function contains<T>(items: T[], item: T): boolean {
  for (var i = 0; i < items.length; i++) {
    if (items[i] === item) return true;
  }
  return false;
}

export function keys(obj: { [key: string]: unknown }): string[] {
  var out: string[] = [];
  for (var k in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(k);
  }
  return out;
}

export function deepCopy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * Removes undefined, null, empty strings, empty arrays and empty objects,
 * recursively. FHIR JSON forbids empty values, so every resource goes through
 * this before it is put into a bundle.
 */
export function compact<T>(value: T): T {
  return compactValue(value) as T;
}

function compactValue(value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (Object.prototype.toString.call(value) === '[object Array]') {
    var arr = value as unknown[];
    var outArr: unknown[] = [];
    for (var i = 0; i < arr.length; i++) {
      var v = compactValue(arr[i]);
      if (v !== undefined) outArr.push(v);
    }
    return outArr.length ? outArr : undefined;
  }
  if (typeof value === 'object') {
    var obj = value as { [key: string]: unknown };
    var outObj: { [key: string]: unknown } = {};
    var any = false;
    for (var k in obj) {
      if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
      var cv = compactValue(obj[k]);
      if (cv !== undefined) {
        outObj[k] = cv;
        any = true;
      }
    }
    return any ? outObj : undefined;
  }
  return value;
}
