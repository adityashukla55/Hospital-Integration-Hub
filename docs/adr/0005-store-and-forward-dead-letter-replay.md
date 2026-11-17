# 0005 — Store-and-forward with dead-letter queue and replay

Status: accepted · 2026-11-17

## Decision

- The KIS is ACKed (`AA`) once OIE has persisted the message, before mapping. The raw message is also stored in `hub.message`, independent of OIE's own message store and its pruning.
- Every failure ends in exactly one place: `Hub 4 - Dead Letter` → `hub.dead_letter`, with a stable error code (`TERMINOLOGY_UNMAPPED`, `VALIDATION_FAILED`, …), the v2 location (`OBX[2]-6`) or the server's OperationOutcome.
- Transient failures are retried by the engine's destination queue with exponential back-off. The back-off is tracked in `hub.message.next_attempt_at`, so a waiting message does not block the queue (rotate).
- Replay (`POST /replay`, ops console) re-processes from the Transform stage and creates a new `hub.message` row linked through `replay_of`.

## Consequences

- An AE/AR ACK is never sent for content problems. The KIS cannot fix them anyway; the integration team works from the dead-letter list.
- Fixing a terminology gap is a data change (a ConceptMap in `terminology/`) plus "Replay all" for that error code. No redeploy is needed.
