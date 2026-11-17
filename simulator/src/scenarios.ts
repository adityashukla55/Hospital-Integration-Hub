import { esc, message, seg, ts } from './hl7.ts';
import { DEPARTMENTS, DIAGNOSES, int, LAB_TESTS, makePatient, PANELS, pick, rng, type Rand, type SyntheticPatient } from './synthetic.ts';

/**
 * Builds realistic message sequences for synthetic hospital stays:
 * admission, lab order and results, transfers, updates, a discharge letter
 * and the discharge. Interface conventions match docs/mapping-spec.md.
 */

export interface GeneratedMessage {
  /** sortable name used for corpus files, e.g. "0007-ADT_A01" */
  name: string;
  type: string;
  raw: string;
  /** wall-clock time the KIS would send it */
  at: Date;
}

const FACILITY = 'KLINIKUM';
const APP = 'KIS';

class Ctx {
  r: Rand;
  seq = 0;
  out: GeneratedMessage[] = [];
  constructor(seed: number) {
    this.r = rng(seed);
  }
  emit(type: string, at: Date, segments: string[]) {
    this.seq++;
    const controlId = `SIM${String(this.seq).padStart(6, '0')}`;
    const msh = seg('MSH', { 3: APP, 4: FACILITY, 5: 'HUB', 6: FACILITY, 7: ts(at), 9: type, 10: controlId, 11: 'P', 12: '2.5', 15: 'AL', 16: 'NE', 18: 'UNICODE UTF-8' });
    const [code, event] = type.split('^');
    this.out.push({ name: `${String(this.seq).padStart(4, '0')}-${code}_${event}`, type: `${code}^${event}`, raw: message(msh, ...segments), at });
  }
}

const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60000);

function pid(p: SyntheticPatient, number = p.number): string {
  const family = p.ownPrefix ? `${p.ownPrefix} ${p.family}&${p.ownPrefix}&${p.family}` : p.family;
  const names = [`${family}^${p.given}^^^^^L`];
  if (p.birthName) names.push(`${p.birthName}^^^^^^B`);
  return seg('PID', {
    1: '1',
    3: `${number}^^^${FACILITY}^PI~${p.kvnr}^^^GKV^KVZ10`,
    5: names.join('~'),
    7: ts(p.birthDate, 'date'),
    8: p.sex,
    11: `${esc(p.street)}^^${p.city}^^${p.zip}^D^H`,
    13: `^PRN^PH^^^^^^^^^${p.phone}`
  });
}

interface Stay {
  fall: string;
  dept: (typeof DEPARTMENTS)[number];
  room: string;
  bed: string;
  admit: Date;
  cls: 'I' | 'O';
}

function pv1(s: Stay, extra: Record<number, string> = {}): string {
  return seg('PV1', {
    1: '1',
    2: s.cls,
    3: `${s.dept.ward}^${s.room}^${s.bed}^${FACILITY}`,
    4: s.cls === 'I' ? 'E' : '',
    10: s.dept.code,
    19: s.fall,
    44: ts(s.admit),
    ...extra
  });
}

function in1(p: SyntheticPatient): string {
  return seg('IN1', { 1: '1', 2: 'GKV', 3: p.insurer[0], 4: p.insurer[1], 15: 'GKV', 17: 'SEL', 36: p.kvnr });
}

function dg1(set: number, d: readonly [string, string, string], at: Date, type: 'A' | 'W' | 'F', rank: number): string[] {
  const segs = [seg('DG1', { 1: String(set), 3: `${d[0]}^${esc(d[1])}^I10^^^^2026`, 5: ts(at), 6: type, 15: String(rank) })];
  segs.push(seg('ZDG', { 1: String(set), 2: type === 'A' ? 'V' : 'G', 3: d[2] }));
  return segs;
}

function labOrderAndResult(c: Ctx, p: SyntheticPatient, s: Stay, at: Date, n: number) {
  const panelCode = pick(c.r, Object.keys(PANELS) as Array<keyof typeof PANELS>);
  const panel = PANELS[panelCode];
  const placer = `ANF-${s.fall.slice(-6)}-${n}`;
  const filler = `LAB-${s.fall.slice(-6)}-${n}`;
  const priority = c.r() < 0.2 ? 'S' : 'R';
  c.emit('OML^O21^OML_O21', at, [
    pid(p),
    pv1(s),
    seg('ORC', { 1: 'NW', 2: placer, 5: 'SC', 9: ts(at), 12: `${int(c.r, 100000000, 999999999)}^Weber^Lena^^^Dr.` }),
    seg('TQ1', { 1: '1', 9: priority }),
    seg('OBR', { 1: '1', 2: placer, 4: `${panelCode}^${panel.text}^L` })
  ]);
  const sampled = addMinutes(at, 20);
  const reported = addMinutes(at, priority === 'S' ? 45 : 180);
  const obx: string[] = [];
  panel.tests.forEach((code, i) => {
    const t = LAB_TESTS.find((x) => x[0] === code)!;
    const [, text, unit, low, high, decimals] = t;
    const span = high - low || 1;
    const value = low + (c.r() * 1.6 - 0.3) * span;
    const v = Math.max(0, value).toFixed(decimals);
    const flag = +v > high ? 'H' : +v < low ? 'L' : 'N';
    const range = low === 0 ? `<${high}` : `${low}-${high}`;
    obx.push(seg('OBX', { 1: String(i + 1), 2: 'NM', 3: `${code}^${text}^L`, 5: v, 6: unit, 7: range, 8: flag, 11: 'F', 14: ts(sampled) }));
    if (flag !== 'N' && c.r() < 0.3) obx.push(seg('NTE', { 1: '1', 3: 'Wert kontrolliert' }));
  });
  c.emit('ORU^R01^ORU_R01', reported, [
    pid(p),
    pv1(s),
    seg('ORC', { 1: 'RE', 2: placer, 3: filler }),
    seg('OBR', { 1: '1', 2: placer, 3: filler, 4: `${panelCode}^${panel.text}^L`, 7: ts(sampled), 22: ts(reported), 25: 'F' }),
    ...obx
  ]);
}

/** A tiny but valid PDF (synthetic, no patient data inside). */
export function syntheticPdf(title: string): string {
  const text = `BT /F1 14 Tf 72 720 Td (${title.replace(/[()\\]/g, '')}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1').toString('base64');
}

function inpatientStay(c: Ctx, p: SyntheticPatient, start: Date, index: number) {
  const dept = pick(c.r, DEPARTMENTS);
  const s: Stay = { fall: `F2026${String(100000 + index).slice(-6)}`, dept, room: String(int(c.r, 100, 450)), bed: String(int(c.r, 1, 3)), admit: start, cls: 'I' };
  const d1 = pick(c.r, DIAGNOSES);
  c.emit('ADT^A01^ADT_A01', addMinutes(start, 5), [
    seg('EVN', { 1: 'A01', 2: ts(addMinutes(start, 5)) }),
    pid(p),
    pv1(s),
    seg('PV2', { 3: '0101' }),
    ...dg1(1, d1, start, 'A', 1),
    in1(p)
  ]);
  labOrderAndResult(c, p, s, addMinutes(start, 30), 1);

  let t = addMinutes(start, int(c.r, 600, 2400));
  if (c.r() < 0.3) {
    const from = { ...s };
    s.dept = pick(c.r, DEPARTMENTS);
    s.room = String(int(c.r, 100, 450));
    c.emit('ADT^A02^ADT_A02', t, [seg('EVN', { 1: 'A02', 2: ts(t) }), pid(p), pv1(s, { 6: `${from.dept.ward}^${from.room}^${from.bed}^${FACILITY}` })]);
    t = addMinutes(t, 60);
    labOrderAndResult(c, p, s, t, 2);
  }
  const treatment = pick(c.r, DIAGNOSES);
  if (c.r() < 0.4) {
    t = addMinutes(t, int(c.r, 60, 600));
    const moved = { ...p, phone: `0${int(c.r, 30, 899)} ${int(c.r, 100000, 9999999)}` };
    c.emit('ADT^A08^ADT_A01', t, [seg('EVN', { 1: 'A08', 2: ts(t) }), pid(moved), pv1(s), ...dg1(1, d1, start, 'A', 2), ...dg1(2, treatment, t, 'W', 1)]);
    Object.assign(p, moved);
  }
  const discharge = addMinutes(start, int(c.r, 2, 9) * 1440 + int(c.r, 0, 300));
  const letter = c.r() < 0.8 ? 'ENTL' : 'VERL';
  const docAt = addMinutes(discharge, -90);
  c.emit('MDM^T02^MDM_T02', docAt, [
    seg('EVN', { 1: 'T02', 2: ts(docAt) }),
    pid(p),
    pv1(s),
    seg('TXA', {
      1: '1',
      2: `${letter}^${letter === 'ENTL' ? 'Entlassbrief' : 'Verlegungsbrief'}^L`,
      3: 'AP',
      4: ts(docAt),
      5: '^Weber^Lena^^^Dr.',
      6: ts(addMinutes(docAt, -30)),
      12: `DOC-${s.fall}-1`,
      17: 'AU',
      18: 'N',
      19: 'AV'
    }),
    seg('OBX', { 1: '1', 2: 'ED', 3: `${letter}^Arztbrief^L`, 5: `^AP^PDF^Base64^${syntheticPdf('Synthetic letter ' + s.fall)}`, 11: 'F' })
  ]);
  c.emit('ADT^A03^ADT_A03', discharge, [
    seg('EVN', { 1: 'A03', 2: ts(discharge) }),
    pid(p),
    pv1(s, { 36: letter === 'VERL' ? '069' : '019', 45: ts(discharge) }),
    ...dg1(1, d1, start, 'A', 2),
    ...dg1(2, treatment, discharge, 'F', 1)
  ]);
}

function outpatientVisit(c: Ctx, p: SyntheticPatient, start: Date, index: number) {
  const s: Stay = { fall: `A2026${String(100000 + index).slice(-6)}`, dept: pick(c.r, DEPARTMENTS), room: 'AMB', bed: '', admit: start, cls: 'O' };
  c.emit('ADT^A04^ADT_A01', start, [seg('EVN', { 1: 'A04', 2: ts(start) }), pid(p), pv1(s), in1(p)]);
  labOrderAndResult(c, p, s, addMinutes(start, 15), 1);
}

/**
 * The synthetic corpus: `patients` stays (some outpatient), plus duplicate
 * registrations that are later merged with ADT^A40.
 */
export function generateCorpus(patients: number, seed = 20261117): GeneratedMessage[] {
  const c = new Ctx(seed);
  const base = Date.UTC(2026, 10, 2, 7, 0, 0);
  for (let i = 0; i < patients; i++) {
    const p = makePatient(c.r, i);
    const start = new Date(base + i * 97 * 60000);
    if (i % 6 === 5) outpatientVisit(c, p, start, i);
    else inpatientStay(c, p, start, i);
    if (i % 12 === 3) {
      // the patient was registered twice; the duplicate is merged into the original
      const dupNumber = String(2000000 + i);
      const dupStay: Stay = { fall: `D2026${String(100000 + i).slice(-6)}`, dept: DEPARTMENTS[0], room: 'NA1', bed: '1', admit: new Date(start.getTime() - 3600000), cls: 'O' };
      c.emit('ADT^A04^ADT_A01', dupStay.admit, [seg('EVN', { 1: 'A04', 2: ts(dupStay.admit) }), pid(p, dupNumber), pv1(dupStay)]);
      const at = addMinutes(start, 240);
      c.emit('ADT^A40^ADT_A39', at, [seg('EVN', { 1: 'A40', 2: ts(at) }), pid(p), seg('MRG', { 1: `${dupNumber}^^^${FACILITY}^PI` })]);
    }
  }
  // order by sending time, as a KIS would emit them
  const sorted = [...c.out].sort((a, b) => a.at.getTime() - b.at.getTime() || a.name.localeCompare(b.name));
  return sorted.map((m, i) => ({ ...m, name: `${String(i + 1).padStart(4, '0')}-${m.name.split('-')[1]}` }));
}
