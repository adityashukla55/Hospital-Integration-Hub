// Hub 2 - Transform / destination "Map to FHIR"
// HL7 v2 -> FHIR transaction bundle (HubMapper.transform never throws).
var hubMessageId = String(sourceMap.get('hubMessageId'));
return hubGuard(hubMessageId, 'TRANSFORM', function () {
  var raw = String(connectorMessage.getRawData());
  var out = HubMapper.transform(raw, { terminology: hubTerminology(), config: hubMapperConfig() });

  if (out.status === 'MAPPED') {
    hubSetStatus(hubMessageId, 'MAPPED', null, null, 'mapped_at = now(), issues = ?::jsonb', [JSON.stringify(out.result.issues)]);
    // per-patient partition for the Deliver channel's thread assignment
    hubRoute('Hub 3 - Deliver', JSON.stringify(out.result), hubMessageId, { hubPartition: out.result.partitionKey || hubMessageId });
    return new Response(Status.SENT, out.message.type + ' -> ' + out.result.bundle.entry.length + ' bundle entries');
  }

  if (out.status === 'IGNORED') {
    hubSetStatus(hubMessageId, 'IGNORED', 'UNSUPPORTED_MESSAGE', out.reason);
    return new Response(Status.SENT, out.reason);
  }

  // out.status === 'ERROR'
  if (out.retryable) {
    // e.g. terminology server unavailable: the destination queue retries
    hubSetStatus(hubMessageId, 'RETRYING', out.code, out.message);
    return new Response(Status.QUEUED, out.code + ': ' + out.message);
  }
  hubDeadLetter(hubMessageId, 'TRANSFORM', out.code, out.message, { location: out.location || null });
  return new Response(Status.ERROR, out.code + ': ' + out.message, out.code);
});
