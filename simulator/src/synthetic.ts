/**
 * Deterministic synthetic patients. Everything is generated from a seed, so
 * the corpus (and its golden files) is reproducible. No real person data.
 */

export function rng(seed: number): () => number {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rand = ReturnType<typeof rng>;
export const pick = <T>(r: Rand, items: readonly T[]): T => items[Math.floor(r() * items.length)];
export const int = (r: Rand, min: number, max: number) => min + Math.floor(r() * (max - min + 1));

/**
 * KVNR (Krankenversichertennummer, unchangeable part): one letter, eight
 * digits and a check digit. The letter becomes its two-digit alphabet
 * position, the ten digits are weighted 1-2-1-2..., two-digit products are
 * replaced by their digit sum, and the check digit is the total modulo 10.
 */
export function kvnrCheckDigit(letter: string, eightDigits: string): number {
  const pos = letter.toUpperCase().charCodeAt(0) - 64;
  const digits = (String(pos).padStart(2, '0') + eightDigits).split('').map(Number);
  let sum = 0;
  digits.forEach((d, i) => {
    const p = d * (i % 2 === 0 ? 1 : 2);
    sum += p > 9 ? Math.floor(p / 10) + (p % 10) : p;
  });
  return sum % 10;
}

export function makeKvnr(r: Rand): string {
  const letter = String.fromCharCode(65 + int(r, 0, 25));
  let digits = '';
  for (let i = 0; i < 8; i++) digits += int(r, 0, 9);
  return letter + digits + kvnrCheckDigit(letter, digits);
}

export const FAMILY = [
  'Müller', 'Schmidt', 'Schneider', 'Fischer', 'Weber', 'Meyer', 'Wagner', 'Becker', 'Schulz', 'Hoffmann',
  'Koch', 'Richter', 'Klein', 'Wolf', 'Schröder', 'Neumann', 'Schwarz', 'Zimmermann', 'Braun', 'Krüger',
  'Hartmann', 'Lange', 'Werner', 'Krause', 'Lehmann', 'Yılmaz', 'Kaya', 'Nowak', 'Kowalski', 'Popescu'
] as const;
export const NAME_PREFIX = ['von', 'van der', 'zu'] as const;
export const GIVEN_F = ['Anna', 'Emma', 'Mia', 'Sophie', 'Lena', 'Marie', 'Hannah', 'Leonie', 'Elif', 'Zeynep', 'Ursula', 'Helga', 'Petra', 'Sabine'] as const;
export const GIVEN_M = ['Lukas', 'Leon', 'Finn', 'Paul', 'Jonas', 'Elias', 'Noah', 'Ben', 'Emir', 'Mehmet', 'Klaus', 'Jürgen', 'Wolfgang', 'Dieter'] as const;
export const STREETS = ['Hauptstraße', 'Bahnhofstraße', 'Gartenweg', 'Lindenallee', 'Schillerplatz', 'Goethestraße', 'Am Mühlbach', 'Kirchgasse'] as const;
export const CITIES = [
  ['Musterstadt', '12345'],
  ['Beispielhausen', '23456'],
  ['Neudorf', '34567'],
  ['Altheim', '45678'],
  ['Bergen am See', '56789']
] as const;
export const INSURERS = [
  ['108018007', 'Muster-Krankenkasse'],
  ['109519176', 'Beispiel Ersatzkasse'],
  ['107310373', 'BKK Musterwerke'],
  ['101317004', 'IKK Beispielland']
] as const;
/** Fachabteilungsschlüssel with matching wards */
export const DEPARTMENTS = [
  { code: '0100', ward: 'INN1', name: 'Innere Medizin' },
  { code: '0300', ward: 'KAR2', name: 'Kardiologie' },
  { code: '1500', ward: 'CHI1', name: 'Allgemeine Chirurgie' },
  { code: '2300', ward: 'ORT1', name: 'Orthopädie' },
  { code: '0800', ward: 'PNE1', name: 'Pneumologie' }
] as const;
export const DIAGNOSES = [
  ['I21.0', 'Akuter transmuraler Myokardinfarkt der Vorderwand', ''],
  ['I10.90', 'Essentielle Hypertonie, nicht näher bezeichnet', ''],
  ['J18.9', 'Pneumonie, nicht näher bezeichnet', ''],
  ['E11.90', 'Diabetes mellitus, Typ 2, ohne Komplikationen', ''],
  ['M17.1', 'Sonstige primäre Gonarthrose', 'R'],
  ['S72.00', 'Schenkelhalsfraktur, Teil nicht näher bezeichnet', 'L'],
  ['K35.8', 'Akute Appendizitis, nicht näher bezeichnet', ''],
  ['N39.0', 'Harnwegsinfektion, Lokalisation nicht näher bezeichnet', '']
] as const;
/** local lab code, text, local unit, low, high, decimals */
export const LAB_TESTS = [
  ['NA', 'Natrium', 'mmol/l', 135, 145, 0],
  ['K', 'Kalium', 'mmol/l', 3.5, 5.1, 1],
  ['KREA', 'Kreatinin', 'mg/dl', 0.5, 1.1, 2],
  ['CRP', 'C-reaktives Protein', 'mg/dl', 0, 0.5, 1],
  ['HB', 'Hämoglobin', 'g/dl', 12, 16, 1],
  ['LEUKO', 'Leukozyten', '/nl', 4, 10, 1],
  ['THROMB', 'Thrombozyten', '/nl', 150, 400, 0],
  ['GLUC', 'Glukose', 'mg/dl', 70, 110, 0],
  ['TSH', 'TSH basal', 'mU/l', 0.4, 4, 2],
  ['TNTHS', 'Troponin T hochsensitiv', 'ng/l', 0, 14, 0]
] as const;
export const PANELS = {
  ELYT: { text: 'Elektrolyte', tests: ['NA', 'K'] },
  BB: { text: 'Kleines Blutbild', tests: ['HB', 'LEUKO', 'THROMB'] },
  KLCH: { text: 'Klinische Chemie', tests: ['KREA', 'CRP', 'GLUC'] },
  SD: { text: 'Schilddrüse', tests: ['TSH'] },
  CARD: { text: 'Kardiale Marker', tests: ['TNTHS'] }
} as const;

export interface SyntheticPatient {
  number: string;
  kvnr: string;
  family: string;
  ownPrefix: string;
  given: string;
  sex: 'F' | 'M' | 'D';
  birthDate: Date;
  street: string;
  city: string;
  zip: string;
  phone: string;
  insurer: readonly [string, string];
  birthName?: string;
}

export function makePatient(r: Rand, index: number): SyntheticPatient {
  const sex = r() < 0.02 ? 'D' : r() < 0.5 ? 'F' : 'M';
  const family = pick(r, FAMILY);
  const ownPrefix = r() < 0.08 ? pick(r, NAME_PREFIX) : '';
  const [city, zip] = pick(r, CITIES);
  const birthDate = new Date(Date.UTC(int(r, 1935, 2008), int(r, 0, 11), int(r, 1, 28)));
  return {
    number: String(1000000 + index),
    kvnr: makeKvnr(r),
    family,
    ownPrefix,
    given: sex === 'M' ? pick(r, GIVEN_M) : pick(r, GIVEN_F),
    sex,
    birthDate,
    street: `${pick(r, STREETS)} ${int(r, 1, 120)}${r() < 0.15 ? 'a' : ''}`,
    city,
    zip,
    phone: `0${int(r, 30, 899)} ${int(r, 100000, 9999999)}`,
    insurer: pick(r, INSURERS),
    birthName: sex === 'F' && r() < 0.3 ? pick(r, FAMILY) : undefined
  };
}
