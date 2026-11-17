# 0006 — Site terminology as FHIR ConceptMaps, resolved with $translate

Status: accepted · 2026-11-17

## Decision

Site-specific code mappings (local lab codes → LOINC, local units → UCUM, local document types → KDL) are FHIR ConceptMaps in `terminology/`. They are seeded into HAPI at deploy time and queried with `ConceptMap/$translate` (cached per channel for 5 minutes). KDL → IHE XDS type/class codes use the official DVMD ConceptMaps from `dvmd.kdl.r4`. Fixed HL7 v2 tables and §301 code lists stay in code (`mapper/src/terminology/v2tables.ts`), because they are defined by the standards and are not site configuration.

## Consequences

- One source of truth: the same files drive the unit tests (in memory) and production (`$translate`).
- Terminologists can review and extend maps without touching code.
- Unmapped codes fail loudly. ISiK requires LOINC and UCUM for lab results, so a silent fallback would only move the error to the FHIR server or to the consumers.
