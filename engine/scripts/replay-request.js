// Hub 5 - Replay / destination "Replay messages"
// POST /replay {"messageIds": [12, 13]} re-processes stored messages from
// the Transform stage. Each replay is a new hub.message row (replay_of points
// to the original), so the history of every attempt is kept.
var body = String(connectorMessage.getRawData() || '');
var request = body ? JSON.parse(body) : {};
var ids = request.messageIds || (request.messageId ? [request.messageId] : []);
var results = [];
for (var i = 0; i < ids.length; i++) {
  var id = String(ids[i]);
  if (!/^\d+$/.test(id)) {
    results.push({ messageId: id, error: 'invalid id' });
    continue;
  }
  var copy = hubDbQueryOne(
    'INSERT INTO hub.message (sending_application, sending_facility, control_id, message_type, raw, replay_of) ' +
      'SELECT sending_application, sending_facility, control_id, message_type, raw, id FROM hub.message WHERE id = ?::bigint RETURNING id, raw',
    [id]
  );
  if (!copy) {
    results.push({ messageId: id, error: 'not found' });
    continue;
  }
  hubDbUpdate('UPDATE hub.dead_letter SET replayed_at = now(), replayed_as = ?::bigint WHERE message_id = ?::bigint AND replayed_at IS NULL', [copy.id, id]);
  hubRoute('Hub 2 - Transform', copy.raw, copy.id);
  results.push({ messageId: id, replayId: copy.id });
}
return new Response(Status.SENT, JSON.stringify({ replayed: results }));
