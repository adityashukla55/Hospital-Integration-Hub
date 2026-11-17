// Hub 4 - Dead Letter / destination "Record dead letter"
// Single place where failures are recorded, so alerting and dashboards
// only need to watch one channel and one table.
var dl = JSON.parse(String(connectorMessage.getRawData()));
hubRecordDeadLetter(dl.messageId, dl.stage, dl.code, dl.message, dl.details);
logger.warn('[hub] dead letter: message ' + dl.messageId + ' ' + dl.stage + ' ' + dl.code + ' - ' + dl.message);
return new Response(Status.SENT, dl.stage + ' ' + dl.code);
