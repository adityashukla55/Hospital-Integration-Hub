// Hub 3 - Deliver / destination "Deliver to FHIR server"
// Queue: on failure, rotate. A RETRY outcome is re-queued with exponential
// back-off (tracked in hub.message.next_attempt_at, so a waiting message does
// not block the ones behind it); after hub.deliver.maxWaitSeconds it is
// dead-lettered. FAILED outcomes (validation errors, ambiguous matches) go to
// the dead-letter queue immediately.
var hubMessageId = String(sourceMap.get('hubMessageId'));
return hubGuard(hubMessageId, 'DELIVER', function () {
  var state = hubDbQueryOne(
    'SELECT attempts, EXTRACT(EPOCH FROM (now() - COALESCE(first_attempt_at, now()))) AS waited, ' +
      '(next_attempt_at IS NOT NULL AND next_attempt_at > now()) AS not_yet FROM hub.message WHERE id = ?::bigint',
    [hubMessageId]
  );
  if (state && state.not_yet === 'true') {
    return new Response(Status.QUEUED, 'waiting for next attempt');
  }

  var payload = connectorMessage.getEncodedData() || connectorMessage.getRawData();
  var result = JSON.parse(String(payload));
  var out = HubMapper.deliverSafely(result, hubFhirClient());
  var attempts = (state ? parseInt(state.attempts, 10) : 0) + 1;
  var issues = JSON.stringify(result.issues.concat(out.issues || []));

  if (out.status === 'DELIVERED') {
    hubSetStatus(hubMessageId, 'DELIVERED', null, out.message, 'delivered_at = now(), attempts = ?::int, issues = ?::jsonb, fhir_locations = ?::jsonb, next_attempt_at = NULL', [
      attempts,
      issues,
      JSON.stringify(out.locations || [])
    ]);
    return new Response(Status.SENT, (out.locations || []).length + ' resources written', null);
  }

  if (out.status === 'RETRY') {
    var maxWait = parseInt(hubSetting('hub.deliver.maxWaitSeconds', '600'), 10);
    var waited = state ? parseFloat(state.waited) : 0;
    if (waited >= maxWait) {
      hubDeadLetter(hubMessageId, 'DELIVER', 'RETRY_EXHAUSTED', out.code + ' after ' + attempts + ' attempts: ' + out.message, { lastCode: out.code, httpStatus: out.httpStatus || null });
      return new Response(Status.ERROR, 'RETRY_EXHAUSTED: ' + out.message, out.code);
    }
    var maxBackoff = parseInt(hubSetting('hub.deliver.maxBackoffSeconds', '60'), 10);
    var delay = Math.min(Math.pow(2, attempts - 1), maxBackoff);
    hubSetStatus(hubMessageId, 'RETRYING', out.code, out.message, "attempts = ?::int, first_attempt_at = COALESCE(first_attempt_at, now()), next_attempt_at = now() + (? || ' seconds')::interval", [attempts, delay]);
    return new Response(Status.QUEUED, out.code + ': ' + out.message + ' (next attempt in ' + delay + ' s)');
  }

  hubDeadLetter(hubMessageId, 'DELIVER', out.code, out.message, { httpStatus: out.httpStatus || null, serverIssues: out.serverIssues || [] });
  return new Response(Status.ERROR, out.code + ': ' + out.message, out.code);
});
