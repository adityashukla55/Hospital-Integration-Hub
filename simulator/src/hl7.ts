/** Minimal HL7 v2 writing helpers for the simulator. */

export const CR = '\r';

/** Builds a segment from numbered fields: seg('PV1', { 2: 'I', 19: 'F1' }). */
export function seg(name: string, fields: Record<number, string | undefined>): string {
  const nums = Object.keys(fields).map(Number);
  const max = nums.length ? Math.max(...nums) : 0;
  if (name === 'MSH') {
    const parts: string[] = [];
    for (let i = 3; i <= max; i++) parts.push(fields[i] ?? '');
    return 'MSH|^~\\&|' + parts.join('|');
  }
  const parts = [name];
  for (let i = 1; i <= max; i++) parts.push(fields[i] ?? '');
  return parts.join('|');
}

/** Escapes delimiter characters inside a field value. */
export function esc(value: string): string {
  return value.replace(/\\/g, '\\E\\').replace(/\|/g, '\\F\\').replace(/\^/g, '\\S\\').replace(/&/g, '\\T\\').replace(/~/g, '\\R\\');
}

export function message(...segments: string[]): string {
  return segments.join(CR);
}

/** YYYYMMDDHHMMSS in local wall-clock time of the given Date (UTC components used as local). */
export function ts(d: Date, precision: 'date' | 'minute' | 'second' = 'second'): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const date = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  if (precision === 'date') return date;
  const minute = `${date}${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return precision === 'minute' ? minute : `${minute}${p(d.getUTCSeconds())}`;
}

/** Reads MSA-1 (AA/AE/AR or CA/CE/CR) and MSA-3 from an ACK. */
export function parseAck(ack: string): { code: string; controlId: string; text: string } {
  const msa = ack.split(/\r|\n/).find((s) => s.startsWith('MSA'));
  if (!msa) return { code: '', controlId: '', text: 'no MSA segment' };
  const f = msa.split('|');
  return { code: f[1] ?? '', controlId: f[2] ?? '', text: f[3] ?? '' };
}
