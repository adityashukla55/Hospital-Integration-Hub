import type { Coding, Identifier, ServiceRequest } from 'fhir/r4';
import { MappingError } from '../errors';
import { CS } from '../fhir/profiles';
import { readCwe, readEi, readXcn, xcnDisplay } from '../hl7/datatypes';
import { Segment } from '../hl7/parser';
import { PRIORITY, serviceRequestStatus } from '../terminology/v2tables';
import { trim } from '../util/lang';
import { toFhirDateTime } from '../util/time';
import { MapContext } from './context';
import { mapPatient } from './patient';
import { encounterReference } from './results';

/**
 * ORM^O01 and OML^O21 to ServiceRequest (ISiK Stufe 5 has no ServiceRequest
 * profile, so these are base R4). One ServiceRequest per ORC, keyed by the
 * placer order number so status changes (ORC-1 CA/DC/SC) update it in place.
 */
export function mapOrders(ctx: MapContext): void {
  var msg = ctx.msg;
  var patient = mapPatient(ctx, msg.require('PID'));
  var patientFullUrl = ctx.tx.createIfMissing(patient.resource, patient.identifier);
  var encounterRef = encounterReference(ctx, msg.segment('PV1'));
  var isLab = msg.header.messageCode === 'OML';

  var segs = msg.segments;
  var count = 0;
  for (var i = 0; i < segs.length; i++) {
    if (segs[i].name !== 'ORC') continue;
    var orc = segs[i];
    var detail: Segment | undefined;
    var tq1: Segment | undefined;
    var notes: Segment[] = [];
    for (var j = i + 1; j < segs.length && segs[j].name !== 'ORC'; j++) {
      var s = segs[j];
      if ((s.name === 'OBR' || s.name === 'RXO') && !detail) detail = s;
      else if (s.name === 'TQ1' && !tq1) tq1 = s;
      else if (s.name === 'NTE') notes.push(s);
    }
    count++;
    var loc = 'ORC[' + count + ']';
    var placer = readEi(orc.rep(2)).id || (detail ? readEi(detail.rep(2)).id : '');
    var filler = readEi(orc.rep(3)).id || (detail ? readEi(detail.rep(3)).id : '');
    if (!placer) throw new MappingError('MISSING_REQUIRED_FIELD', 'placer order number is required', loc + '-2');

    var placerId: Identifier = { type: { coding: [{ system: CS.v2_0203, code: 'PLAC' }] }, system: ctx.cfg.systems.placerOrder, value: placer };
    var identifiers: Identifier[] = [placerId];
    if (filler) identifiers.push({ type: { coding: [{ system: CS.v2_0203, code: 'FILL' }] }, system: ctx.cfg.systems.fillerOrder, value: filler });

    var service = detail ? readCwe(detail.rep(4)) : readCwe(undefined);
    if (!service.code) throw new MappingError('MISSING_REQUIRED_FIELD', 'universal service identifier is required', (detail ? detail.name : 'OBR') + '-4');
    var codings: Coding[] = [];
    if (service.system === 'LN') codings.push({ system: CS.loinc, code: service.code, display: service.text || undefined });
    else {
      var t = ctx.terminology.translate(ctx.cfg.conceptMaps.labToLoinc, ctx.cfg.systems.localLabCodes, service.code);
      if (t) codings.push({ system: CS.loinc, code: t.code, display: t.display });
      codings.push({ system: ctx.cfg.systems.localLabCodes, code: service.code, display: service.text || undefined });
    }

    var priorityCode = (tq1 && tq1.get(9, 1)) || orc.get(7, 6) || (detail ? detail.get(27, 6) : '');
    var requester = readXcn(orc.rep(12));
    var noteTexts: Array<{ text: string }> = [];
    for (var n = 0; n < notes.length; n++) {
      var text = trim(notes[n].get(3));
      if (text) noteTexts.push({ text: text });
    }

    var request: ServiceRequest = {
      resourceType: 'ServiceRequest',
      identifier: identifiers,
      status: serviceRequestStatus(orc.get(1), orc.get(5)) as ServiceRequest['status'],
      intent: 'order',
      category: isLab ? [{ coding: [{ system: CS.snomed, code: '108252007', display: 'Laboratory procedure' }] }] : undefined,
      priority: PRIORITY[priorityCode] as ServiceRequest['priority'],
      code: { coding: codings, text: service.text || undefined },
      subject: { reference: patientFullUrl },
      encounter: encounterRef,
      authoredOn: toFhirDateTime(orc.get(9, 1), ctx.cfg.timezone),
      requester: requester.family ? { display: xcnDisplay(requester) } : undefined,
      note: noteTexts.length ? noteTexts : undefined
    };
    ctx.tx.upsert(request, placerId);
  }
  if (!count) throw new MappingError('MISSING_REQUIRED_FIELD', 'at least one ORC segment is required', 'ORC');
}
