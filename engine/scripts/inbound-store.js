// Hub 1 - Inbound / destination "Store and route"
// The KIS already has its ACK (sent before processing). Persist the raw
// message first, then hand it to the Transform channel by id.
var raw = String(connectorMessage.getRawData());
var h = { messageCode: '', triggerEvent: '', sendingApplication: '', sendingFacility: '', controlId: '' };
try {
  h = HubMapper.parseHl7(raw).header;
} catch (e) {
  // unparseable messages are stored too; the Transform channel dead-letters them with PARSE_ERROR
}
var row = hubDbQueryOne(
  'INSERT INTO hub.message (sending_application, sending_facility, control_id, message_type, raw, oie_message_id) ' +
    'VALUES (?, ?, ?, ?, ?, ?::bigint) RETURNING id',
  [h.sendingApplication, h.sendingFacility, h.controlId, h.messageCode ? h.messageCode + '^' + h.triggerEvent : null, raw, connectorMessage.getMessageId()]
);
var hubMessageId = row.id;
channelMap.put('hubMessageId', hubMessageId);
hubRoute('Hub 2 - Transform', raw, hubMessageId);
return new Response(Status.SENT, 'stored as hub message ' + hubMessageId);
