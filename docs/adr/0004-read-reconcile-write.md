# 0004 — Read-reconcile-write for Patient and Encounter

Status: accepted · 2026-11-17

## Context

Conditional updates (`PUT Patient?identifier=…`) are idempotent but replace the whole resource. That loses state built up across messages: merge aliases, older locations, diagnoses sent only with the admission. It also lets an old message that arrives late overwrite newer data.

## Decision

The delivery step reads the stored Patient and Encounter before writing and merges with pure, unit-tested rules (`mapper/src/delivery/reconcile.ts`):

- Patient: keep `use=old` identifiers, unknown identifier systems and links; keep the stored demographics when the message's event time is older than the last applied event (recorded in Provenance), or when the message uses a retired (merged) number.
- Encounter: status only moves forward; dropped locations become `completed`; diagnoses, account, discharge and admit details survive messages without them.

The result is written with `If-Match` on the version that was read, inside the same transaction as everything else from the message.

## Consequences

- The preflight reads must see the current state. HAPI by default answers an identical search from a 60-second result cache. In the end-to-end run, a survivor's ADT^A02 shortly after its admission read the cached "no such patient" result, skipped the reconcile, and dropped the merge alias that the A40 had just written. Preflight reads now send `Cache-Control: no-cache`, and the server has `reuse_cached_search_results_millis: 0`. A unit test checks the header, and the delivery tests cover an ADT after a merge.

- Two extra GETs per ADT message.
- Concurrent writers cannot overwrite each other silently: a 409 sends the message back to the retry queue with a fresh read.
- A reopened case (A13 cancel discharge) would need an explicit rule; it is not implemented yet.
