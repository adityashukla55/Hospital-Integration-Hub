# 0002 — Open Integration Engine instead of commercial Mirth Connect

Status: accepted · 2026-11-17

## Context

Since version 4.6 (March 2025) Mirth Connect is no longer released as open source. Many German hospitals run Mirth 3.x/4.x and are deciding between a commercial licence and a fork. Open Integration Engine (OIE) is the community fork of the last open-source Mirth code base (MPL-2.0) and keeps its channel model, XML format and REST API.

## Decision

Use OIE 4.5.2 (`openintegrationengine/engine:4.5.2-ubuntu-jre`) with Postgres as its own database.

## Consequences

- Channels, code templates and the deploy tooling are compatible with Mirth Connect 4.x, so the repo is useful for both.
- No licence key is needed to run the demo.
- The OIE image is amd64-only today; on Apple Silicon it runs under emulation.
