# Results

Measured on 17 Nov 2026 with the full stack from `docker-compose.yml` on one laptop: Docker VM with 4 vCPU and 4 GB RAM, x86_64, all seven containers running (OIE, HAPI, Postgres, ops, Prometheus, Grafana). These are single-machine numbers for orientation, not a benchmark of the products.

## Conformance

| Check | Result |
| --- | --- |
| Corpus of 209 synthetic messages (ADT A01/A02/A03/A04/A08/A40, OML^O21, ORU^R01, MDM^T02) through MLLP → OIE → HAPI with ISiK 5.2.0 request validation | 209/209 delivered, 0 dead letters |
| Resources written by the corpus | 39 Patient (36 people + 3 duplicates merged by A40), 39 Encounter, 39 Account, 36 Coverage, 71 Condition, 90 Observation, 44 DiagnosticReport, 44 ServiceRequest, 30 DocumentReference, 30 Binary, 209 Provenance |
| Same 209 messages sent again | 209/209 delivered, 0 new resources |
| Replay of a delivered message through the replay API | delivered, 0 new resources |
| Hand-written negative cases | unmapped lab code → `TERMINOLOGY_UNMAPPED` at `OBX[1]-3`; non-HL7 payload → `PARSE_ERROR`; ADT^A31 → `IGNORED` |
| Direct write of a Patient that claims ISiKPatient but has no data | rejected by HAPI with HTTP 422 |
| Golden output in the engine's Rhino 1.7.13 vs Node | 223/223 identical |

Request validation found one real gap during the first run. `DocumentReference.content.format` binds to the IHE format code system, which is not among ISiK's declared dependencies, so `ihe.formatcode.fhir` 1.4.0 is now installed ([ADR 0003](adr/0003-hapi-fhir-validation-on-write.md)).

The end-to-end run also found a concurrency bug that unit tests could not: HAPI's 60-second search result cache made a read-reconcile-write miss a merge alias, and one duplicate Patient appeared when the corpus was re-sent. It is fixed (no-cache preflight reads, cache reuse off; [ADR 0004](adr/0004-read-reconcile-write.md)). The conformance results above come from a clean run after the fix: fresh volumes, `docker compose up` ready in 467 s, all 13 end-to-end checks passing.

The HL7 FHIR Validator CLI run (`tools/validate.sh`) is part of CI. It was not run on the development machine.

## Throughput

Load generator: `simulator/src/cli.ts load`, original-mode MLLP (one message in flight per connection, 5 connections), corpus messages with fresh control ids.

| Scenario | Messages | Result |
| --- | --- | --- |
| Ingestion (MLLP → stored → ACK), 30 s at a 50 msg/s target | 1,280 | 42.7 msg/s achieved, ACK p50 35 ms, p95 210 ms, p99 408 ms, max 718 ms, 0 rejected |
| Delivery, HAPI validation off (`HAPI_VALIDATION_ENABLED=false`) | 1,280 | 1,280 delivered in 250 s: 5.1 msg/s; Inbound/Transform stages about 12 msg/s |
| Delivery, ISiK validation on | 280 | 280 delivered in 271 s: 1.0 msg/s |
| Corpus first pass (clean server, 209 messages sent in 12 s), ISiK validation on | 209 | all delivered after 226 s: 0.9 msg/s; end-to-end p50 85 s, p95 181 s (queueing behind validation) |

How to read this:

- The KIS only waits for the ACK. ACK latency stays in the low hundreds of milliseconds because of store-and-forward, even when FHIR delivery is far behind.
- The cost of validation on write is about 1 s per transaction in HAPI 8.12 on this machine. A warm `$validate` of one ISiKPatient takes 0.6–2.5 s, against 0.2 s for an unprofiled Patient. The structurally simpler ISiK Coverage validates in about 0.3 s.
- Fixes that came out of profiling: mapping in Rhino went from 107 ms to 23 ms per ADT message (hashing), and JDBC connections are pooled. HAPI ValueSet pre-expansion was disabled after it kept the server at 200–300% CPU.

## Reproduce

```bash
make clean up                                   # fresh volumes
cd simulator && node src/e2e.ts                 # conformance and idempotency (writes reports/e2e.json)
node src/cli.ts load --rate 50 --seconds 30     # ingestion
```
