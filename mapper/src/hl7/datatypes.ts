import { Repetition, Segment } from './parser';

/** CX — extended composite ID with check digit */
export interface Cx {
  id: string;
  assigningAuthority: string;
  assigningAuthorityUniversalId: string;
  typeCode: string;
  assigningFacility: string;
}

export function readCx(r: Repetition): Cx {
  return {
    id: r.c(1),
    assigningAuthority: r.c(4, 1),
    assigningAuthorityUniversalId: r.c(4, 2),
    typeCode: r.c(5),
    assigningFacility: r.c(6, 1)
  };
}

/** CE / CWE — coded element */
export interface Cwe {
  code: string;
  text: string;
  system: string;
  altCode: string;
  altText: string;
  altSystem: string;
  systemVersion: string;
  originalText: string;
}

export function readCwe(r: Repetition | undefined): Cwe {
  if (!r) return { code: '', text: '', system: '', altCode: '', altText: '', altSystem: '', systemVersion: '', originalText: '' };
  return {
    code: r.c(1),
    text: r.c(2),
    system: r.c(3),
    altCode: r.c(4),
    altText: r.c(5),
    altSystem: r.c(6),
    systemVersion: r.c(7),
    originalText: r.c(9)
  };
}

/** XPN — person name. Component 1 is FN: surname & own surname prefix & own surname & ... */
export interface Xpn {
  family: string;
  /** Vorsatzwort, e.g. "von" */
  ownPrefix: string;
  ownName: string;
  given: string;
  middle: string;
  suffix: string;
  prefix: string;
  degree: string;
  nameType: string;
}

export function readXpn(r: Repetition): Xpn {
  return {
    family: r.c(1, 1),
    ownPrefix: r.c(1, 2),
    ownName: r.c(1, 3),
    given: r.c(2),
    middle: r.c(3),
    suffix: r.c(4),
    prefix: r.c(5),
    degree: r.c(6),
    nameType: r.c(7)
  };
}

/** XAD — address. Component 1 is SAD: street address & street name & dwelling number. */
export interface Xad {
  street: string;
  streetName: string;
  houseNumber: string;
  other: string;
  city: string;
  state: string;
  zip: string;
  country: string;
  type: string;
  district: string;
}

export function readXad(r: Repetition): Xad {
  return {
    street: r.c(1, 1),
    streetName: r.c(1, 2),
    houseNumber: r.c(1, 3),
    other: r.c(2),
    city: r.c(3),
    state: r.c(4),
    zip: r.c(5),
    country: r.c(6),
    type: r.c(7),
    district: r.c(9)
  };
}

/** XTN — telecom */
export interface Xtn {
  legacy: string;
  useCode: string;
  equipment: string;
  email: string;
  countryCode: string;
  areaCode: string;
  localNumber: string;
  extension: string;
  unformatted: string;
}

export function readXtn(r: Repetition): Xtn {
  return {
    legacy: r.c(1),
    useCode: r.c(2),
    equipment: r.c(3),
    email: r.c(4),
    countryCode: r.c(5),
    areaCode: r.c(6),
    localNumber: r.c(7),
    extension: r.c(8),
    unformatted: r.c(12)
  };
}

/** PL — person location */
export interface Pl {
  pointOfCare: string;
  room: string;
  bed: string;
  facility: string;
  status: string;
  building: string;
  floor: string;
  description: string;
}

export function readPl(r: Repetition | undefined): Pl {
  if (!r) return { pointOfCare: '', room: '', bed: '', facility: '', status: '', building: '', floor: '', description: '' };
  return {
    pointOfCare: r.c(1),
    room: r.c(2),
    bed: r.c(3),
    facility: r.c(4, 1),
    status: r.c(5),
    building: r.c(7),
    floor: r.c(8),
    description: r.c(9)
  };
}

/** XCN — extended composite ID and name for persons */
export interface Xcn {
  id: string;
  family: string;
  given: string;
  middle: string;
  suffix: string;
  prefix: string;
  degree: string;
  assigningAuthority: string;
}

export function readXcn(r: Repetition | undefined): Xcn {
  if (!r) return { id: '', family: '', given: '', middle: '', suffix: '', prefix: '', degree: '', assigningAuthority: '' };
  return {
    id: r.c(1),
    family: r.c(2, 1),
    given: r.c(3),
    middle: r.c(4),
    suffix: r.c(5),
    prefix: r.c(6),
    degree: r.c(7),
    assigningAuthority: r.c(9, 1)
  };
}

export function xcnDisplay(x: Xcn): string {
  var parts: string[] = [];
  if (x.prefix) parts.push(x.prefix);
  if (x.degree && x.degree !== x.prefix) parts.push(x.degree);
  if (x.given) parts.push(x.given);
  if (x.family) parts.push(x.family);
  return parts.join(' ');
}

/** EI — entity identifier */
export interface Ei {
  id: string;
  namespace: string;
  universalId: string;
}

export function readEi(r: Repetition | undefined): Ei {
  if (!r) return { id: '', namespace: '', universalId: '' };
  return { id: r.c(1), namespace: r.c(2), universalId: r.c(3) };
}

/** First repetition of a field as CWE. */
export function cweAt(seg: Segment, field: number): Cwe {
  return readCwe(seg.rep(field));
}
