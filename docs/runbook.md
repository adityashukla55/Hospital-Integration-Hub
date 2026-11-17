# Runbook

## Where to look

| Question | Place |
| --- | --- |
| Did message X arrive, what happened to it? | ops console http://localhost:8088 (search by control id) or `hub.message` |
| What is failing right now? | ops console *Open dead letters*, Grafana panel *Open dead letters by code* |
| Is the engine processing? | Grafana *Channel queues*, OIE Administrator dashboard |
| Which FHIR resources did a message write? | message detail → FHIR links; `Provenance?entity…` / `Provenance/hl7v2-<hash>` |

```sql
-- status of the last hour
SELECT status, status_code, count(*) FROM hub.message WHERE received_at > now() - interval '1 hour' GROUP BY 1, 2 ORDER BY 3 DESC;
-- open dead letters by code
SELECT stage, code, count(*) FROM hub.dead_letter WHERE replayed_at IS NULL GROUP BY 1, 2;
```

## Dead-letter codes

| Code | Meaning | Fix |
| --- | --- | --- |
| `TERMINOLOGY_UNMAPPED` | a local lab code, unit or document type has no ConceptMap entry (location says which field) | add the mapping to `terminology/ConceptMap-*.json`, run `make deploy` (re-seeds HAPI), wait for the 5-minute cache or redeploy, then *Replay all* filtered by this code |
| `MISSING_REQUIRED_FIELD` | the KIS did not send a field ISiK needs (e.g. PID-3 patient number, PV1-19 Fallnummer) | fix in the KIS interface; replay after a corrected resend is not needed |
| `INVALID_VALUE` | a value has the wrong format (IK number, ICD code, patient class) | as above |
| `PARSE_ERROR` | not HL7 v2 (missing MSH, wrong delimiters) | check the sender |
| `VALIDATION_FAILED` | HAPI rejected the transaction against ISiK; `details.serverIssues` has the OperationOutcome lines | usually a mapping bug: add a golden case, fix the mapper, `make build deploy`, replay |
| `AMBIGUOUS_MATCH` | a business identifier matches several FHIR resources | clean up duplicates in the FHIR server, replay |
| `RETRY_EXHAUSTED` | transient failures for longer than `hub.deliver.maxWaitSeconds` (default 600 s); `details.lastCode` is the last reason, e.g. `DEPENDENCY_MISSING` when the admission never arrived | resolve the cause (FHIR server, missing A01), replay |
| `ENGINE_ERROR` | unexpected script error | check `docker compose logs oie`; OIE also shows the message as ERROR |

## Replay

- One message: ops console → message → *Replay*, or `curl -X POST localhost:8088/api/messages/<id>/replay`.
- All open dead letters with one code: `curl -X POST localhost:8088/api/dead-letters/replay -H 'Content-Type: application/json' -d '{"code":"TERMINOLOGY_UNMAPPED"}'`.

A replay creates a new `hub.message` row (`replay_of` = original) and starts from the Transform stage. Replays are idempotent: re-sending a message that was already delivered does not create duplicates.

## Configuration

Engine settings are in the OIE configuration map (pushed by `engine/tools/deploy.ts`, editable in Administrator → Settings → Configuration Map):

| Key | Default |
| --- | --- |
| `hub.fhir.baseUrl` | `http://hapi:8080/fhir` |
| `hub.deliver.maxWaitSeconds` | 600 |
| `hub.deliver.maxBackoffSeconds` | 60 |
| `hub.terminology.cacheSeconds` | 300 |
| `hub.mapper.config` | JSON that overrides `mapper/src/config.ts` (identifier namespaces, IK number, timezone, ICD-10-GM version) |

## Changing a channel or the mapper

1. Change `mapper/src` or `engine/src/channels.ts` / `engine/scripts`.
2. `npm test` (golden diffs show the effect; `npm run golden:update` after an intended change).
3. `make build deploy`. Channels are redeployed downstream-first, and queued messages are kept.
