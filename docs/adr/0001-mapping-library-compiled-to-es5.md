# 0001 — Mapping logic as a TypeScript library compiled to ES5

Status: accepted · 2026-11-17

## Context

OIE (like Mirth Connect) runs channel scripts in Rhino 1.7.13. Mapping logic written directly in transformer steps is hard to test: it needs a running engine, has no types, and ends up copy-pasted between channels. The alternative of a Java code template library needs a JDK and a jar deployment, and is still awkward to test against FHIR JSON.

## Decision

All parsing, mapping and delivery logic lives in `mapper/` as TypeScript:

- compiled by `tsc` with `target: ES5` and **`lib: ["ES5"]`**, so the compiler rejects any API Rhino lacks (`Object.assign`, `Array.prototype.find`, `Map`, `startsWith`, ...);
- bundled by esbuild into one IIFE (`mapper/dist/hub-mapper.js`, global `HubMapper`) that is deployed as an OIE code template;
- I/O behind two synchronous ports (`FhirClient`, `Terminology`). The engine supplies Apache HttpClient based adapters; tests supply in-memory fakes.

TypeScript is pinned to 5.9: TypeScript 6 deprecated and 7 removed the ES5 target.

## Consequences

- 61 test cases (50 of them for the mapper and delivery logic, with a fake FHIR server) and 223 golden files run in seconds without Docker.
- `engine/test/rhino-smoke.js` runs the committed bundle in the engine's own Rhino jar and checks it produces byte-identical output to Node for every golden case. This catches runtime differences the compiler cannot (it runs in CI).
- The engine scripts shrink to about 30 lines of glue per channel.
- The bundle is a build artifact that is committed, so `docker compose up` works without Node on the host. CI fails when it is stale.
