# Changelog

All notable changes are documented here. The project follows [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-17

First release.

### Added
- HL7 v2.5 → ISiK Stufe 5 (`de.gematik.isik` 5.2.0) mapping for ADT^A01/A02/A03/A04/A08/A40, ORU^R01, ORM^O01, OML^O21, MDM^T02/T10.
- Delivery with read-reconcile-write for Patient and Encounter, out-of-order rules, A40 merge with reference rewrite, T10 supersede.
- Five OIE 4.5.2 channels as code, deploy tool for the OIE REST API.
- HAPI FHIR 8.12 with pinned ISiK packages and validation on write.
- Hub message store, dead-letter queue, replay API and ops console, Prometheus metrics and a Grafana dashboard.
- Synthetic KIS simulator (209-message corpus, MLLP sender, load test), golden files, Rhino smoke test, CI with the HL7 FHIR Validator.
