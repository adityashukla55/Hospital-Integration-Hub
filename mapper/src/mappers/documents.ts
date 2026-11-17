import type { Binary, DocumentReference, Identifier } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS, PROFILE } from '../fhir/profiles';
import { readCwe, readEi, readXcn, xcnDisplay } from '../hl7/datatypes';
import { CONFIDENTIALITY, DOC_AVAILABILITY, DOC_COMPLETION } from '../terminology/v2tables';
import { deterministicId } from '../util/hash';
import { toFhirDateTime, toFhirInstant } from '../util/time';
import { issue, MapContext } from './context';
import { patientNumberIdentifier, mapPatient } from './patient';
import { encounterReference } from './results';

var MIME: { [key: string]: string } = {
  'AP/PDF': 'application/pdf',
  'APPLICATION/PDF': 'application/pdf',
  'IM/JPEG': 'image/jpeg',
  'IM/PNG': 'image/png',
  'TEXT/PLAIN': 'text/plain',
  'TX/PLAIN': 'text/plain'
};

/**
 * MDM^T02 (original document notification and content) and MDM^T10
 * (document replacement) to ISiKDokumentenMetadaten + ISiKBinary.
 *
 * Document type: TXA-2 is either a KDL code (TXA-2.3 = "KDL") or a local
 * code translated to KDL; the IHE XDS type and class codes are then derived
 * from KDL with the DVMD ConceptMaps.
 */
export function mapDocument(ctx: MapContext): void {
  var msg = ctx.msg;
  var txa = msg.require('TXA');
  var patient = mapPatient(ctx, msg.require('PID'));
  var patientFullUrl = ctx.tx.createIfMissing(patient.resource, patient.identifier);
  var encounterRef = encounterReference(ctx, msg.segment('PV1'));

  var docNumber = readEi(txa.rep(12)).id;
  if (!docNumber) throw new MappingError('MISSING_REQUIRED_FIELD', 'unique document number is required', 'TXA-12');
  var masterIdentifier: Identifier = { system: ctx.cfg.systems.document, value: docNumber };

  // Content: OBX-5 of type ED, possibly split over several OBX segments.
  var obxs = msg.all('OBX');
  var data = '';
  var contentType = '';
  for (var i = 0; i < obxs.length; i++) {
    if (obxs[i].get(2) !== 'ED') continue;
    var subtype = (obxs[i].get(5, 2) + '/' + obxs[i].get(5, 3)).toUpperCase();
    if (!contentType) contentType = MIME[subtype] || '';
    if (obxs[i].get(5, 4).toUpperCase() !== 'BASE64') {
      throw new MappingError('INVALID_VALUE', 'only Base64 encoded document content is supported', 'OBX[' + (i + 1) + ']-5.4');
    }
    data += obxs[i].get(5, 5).replace(/\s+/g, '');
  }
  if (!data) throw new MappingError('MISSING_REQUIRED_FIELD', 'MDM^' + msg.header.triggerEvent + ' must carry the document as OBX-5 (ED, Base64)', 'OBX-5');
  if (!contentType) throw new MappingError('INVALID_VALUE', 'document MIME type (OBX-5.2/5.3) not recognised', 'OBX-5.2');
  if (!/^[A-Za-z0-9+\/]+=*$/.test(data)) throw new MappingError('INVALID_VALUE', 'document content is not valid Base64', 'OBX-5.5');

  var binaryId = deterministicId('doc', ctx.cfg.systems.document + '|' + docNumber);
  var binary: Binary & { id: string } = {
    resourceType: 'Binary',
    id: binaryId,
    meta: { profile: [PROFILE.binary] },
    contentType: contentType,
    data: data
  };
  ctx.tx.put(binary);

  var kdl = documentType(ctx, readCwe(txa.rep(2)));
  var xdsType = ctx.terminology.translate(ctx.cfg.conceptMaps.kdlToXdsType, CS.kdl, kdl.code);
  var xdsClass = ctx.terminology.translate(ctx.cfg.conceptMaps.kdlToXdsClass, CS.kdl, kdl.code);
  if (!xdsClass) throw new MappingError('TERMINOLOGY_UNMAPPED', 'KDL code ' + kdl.code + ' has no IHE XDS class code mapping', 'TXA-2');

  var completion = txa.get(17);
  var availability = txa.get(19);
  var conf = CONFIDENTIALITY[txa.get(18) || 'N'] || CONFIDENTIALITY.N;
  var author = readXcn(txa.rep(5)).family ? readXcn(txa.rep(5)) : readXcn(txa.rep(9));
  var title = txa.get(16) || kdl.display;
  var created = toFhirDateTime(txa.get(6, 1), ctx.cfg.timezone) || toFhirDateTime(txa.get(4, 1), ctx.cfg.timezone) || ctx.eventTime;
  var docDate = toFhirInstant(txa.get(4, 1), ctx.cfg.timezone);
  if (!docDate) issue(ctx, 'information', 'NO_DOCUMENT_DATE', 'activity date/time missing or too imprecise for DocumentReference.date', 'TXA-4');

  var doc: DocumentReference = {
    resourceType: 'DocumentReference',
    meta: { profile: [PROFILE.documentReference] },
    masterIdentifier: masterIdentifier,
    status: (DOC_AVAILABILITY[availability] || 'current') as DocumentReference['status'],
    docStatus: DOC_COMPLETION[completion] as DocumentReference['docStatus'],
    type: {
      coding: [
        { system: CS.kdl, code: kdl.code, display: kdl.display },
        xdsType ? { system: CS.xdsType, code: xdsType.code, display: xdsType.display } : (undefined as never)
      ]
    },
    category: [{ coding: [{ system: CS.xdsClass, code: xdsClass.code, display: xdsClass.display }] }],
    subject: { reference: patientFullUrl, identifier: patientNumberIdentifier(ctx, patient.identifier.value as string) },
    date: docDate,
    author: author.family ? [{ display: xcnDisplay(author) }] : undefined,
    securityLabel: [{ coding: [{ system: CS.confidentiality, code: conf.code, display: conf.display }] }],
    content: [
      {
        attachment: {
          contentType: contentType,
          language: ctx.cfg.documentLanguage,
          url: 'Binary/' + binaryId,
          title: title,
          creation: created
        },
        format: { system: CS.formatCode, code: 'urn:ihe:iti:xds:2017:mimeTypeSufficient', display: 'mimeType Sufficient' }
      }
    ],
    context: {
      encounter: encounterRef ? [encounterRef] : undefined,
      facilityType: { coding: [{ system: CS.facilityType, code: 'KHS', display: 'Krankenhaus' }] }
    }
  };

  var parent = readEi(txa.rep(13)).id;
  if (msg.header.triggerEvent === 'T10' && !parent) {
    throw new MappingError('MISSING_REQUIRED_FIELD', 'MDM^T10 must name the replaced document', 'TXA-13');
  }
  if (parent) {
    var parentIdentifier: Identifier = { system: ctx.cfg.systems.document, value: parent };
    doc.relatesTo = [{ code: 'replaces', target: { type: 'DocumentReference', identifier: parentIdentifier } }];
    ctx.hints.supersede = { identifier: parentIdentifier };
  }
  ctx.tx.upsert(doc, masterIdentifier);
}

function documentType(ctx: MapContext, code: { code: string; text: string; system: string }): { code: string; display: string } {
  if (!code.code) throw new MappingError('MISSING_REQUIRED_FIELD', 'document type is required', 'TXA-2');
  if (code.system === 'KDL') {
    var display = ctx.terminology.lookupDisplay(CS.kdl, code.code) || code.text;
    if (!display) throw new MappingError('TERMINOLOGY_UNMAPPED', 'no display known for KDL code ' + code.code, 'TXA-2');
    return { code: code.code, display: display };
  }
  var t = ctx.terminology.translate(ctx.cfg.conceptMaps.documentTypeToKdl, ctx.cfg.systems.localDocumentTypes, code.code);
  if (!t) throw new MappingError('TERMINOLOGY_UNMAPPED', 'local document type "' + code.code + '" has no KDL mapping', 'TXA-2');
  var d = t.display || ctx.terminology.lookupDisplay(CS.kdl, t.code);
  if (!d) throw new MappingError('TERMINOLOGY_UNMAPPED', 'no display known for KDL code ' + t.code, 'TXA-2');
  return { code: t.code, display: d };
}
