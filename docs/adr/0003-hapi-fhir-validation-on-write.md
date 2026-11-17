# 0003 — HAPI FHIR JPA server with request validation and pinned packages

Status: accepted · 2026-11-17

## Context

ISiK conformance is the point of the project. Validating only in tests would let a mapping regression reach the server unnoticed.

## Decision

- HAPI FHIR 8.12 (JPA, Postgres) with `RequestValidatingInterceptor`: every transaction is validated against the profiles in `meta.profile`, and rejected transactions become dead letters carrying the server's OperationOutcome.
- FHIR packages are installed **explicitly and pinned**, with no transitive installation: `de.gematik.isik` 5.2.0, `de.basisprofil.r4` 1.5.4, `de.ihe-d.terminology` 3.0.1, `ihe.formatcode.fhir` 1.4.0, `dvmd.kdl.r4` 2025.0.1, `de.gematik.terminology` 1.0.6, `hl7.terminology.r4` 7.1.0, `hl7.fhir.uv.extensions.r4` 5.2.0.
- The ISiK package is installed **without its StructureDefinitions as resources**. The validator reads them from HAPI's package cache and generates snapshots lazily.
- ValueSet pre-expansion is switched off.
- In CI the official HL7 FHIR Validator also checks the golden output (`tools/validate.sh`).

## What did not work (HAPI 8.12), and why the configuration looks like this

| Attempt | Failure |
| --- | --- |
| install `de.gematik.isik` with transitive dependencies | `hl7.fhir.uv.extensions.r4` (via SDC) ships SearchParameters for R5-only resources: `HAPI-1684 Unknown resource name "DeviceUsage"` |
| same, SearchParameters excluded | a second, older `hl7.terminology.r4` (6.3.0) fails with `HAPI-1764` |
| explicit list including the ISiK StructureDefinitions | the package is FSH-only (no snapshots); generating the snapshot of `ISiKKoerperkerntemperatur` needs SNOMED CT, and the failure aborts the entire installation (`HAPI-1290`) |
| uploading the profiles through the REST API instead | request validation of the StructureDefinitions themselves fails for 27 of them with an internal error in snapshot processing |
| ValueSet pre-expansion on (default) | background jobs for hundreds of terminology ValueSets kept HAPI at 200–300 % CPU, and with Hibernate Search disabled they failed and retried forever, tripling validation latency |

The gap that request validation found during the first end-to-end run: `DocumentReference.content.format` binds (via IHEXDSformatCodeDE) to the IHE format code system, which is not part of the ISiK dependency list. That is why `ihe.formatcode.fhir` is installed.

## Consequences

- First start takes a few minutes (package download, ValueSet and CodeSystem storage). Later starts reuse the database.
- Validation costs latency on every write. It is the dominant cost of the pipeline (see the load numbers in the README).
- Profiles that the hub does not write (vital signs, medication, appointments) are available to the validator but are never snapshotted.
