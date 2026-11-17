# Hospital Integration Hub (Deutsch)

**HL7 v2 → ISiK Stufe 5 (FHIR R4) mit der Open Integration Engine (Mirth-Fork).**
Ein KIS schickt ADT-, Labor-, Auftrags- und Dokumentnachrichten per MLLP. Der Hub speichert sie, bildet sie auf ISiK-konforme FHIR-Ressourcen ab (Paket `de.gematik.isik` 5.2.0) und schreibt sie in einen HAPI-FHIR-Server, der jede Transaktion gegen die ISiK-Profile validiert.

Ausführliche Dokumentation (englisch): [README.md](README.md), [Mapping-Spezifikation](docs/mapping-spec.md), [Architektur](docs/architecture.md).

## Starten

```bash
make up     # Docker, ca. 4 GB RAM; der erste Start installiert die ISiK-Pakete (einige Minuten)
make demo   # Aufnahme, Laborauftrag und -befund, Verlegung, Entlassbrief, Entlassung
```

Ops-Konsole http://localhost:8088 · FHIR http://localhost:8080/fhir · Grafana http://localhost:3000 · OIE https://localhost:8443

## Abgebildete Nachrichten

| HL7 v2 | ISiK Stufe 5 |
| --- | --- |
| ADT^A01/A04 Aufnahme | ISiKPatient, ISiKKontaktGesundheitseinrichtung, ISiKVersicherungsverhaeltnisGesetzlich, ISiKAbrechnungsfall, ISiKDiagnose |
| ADT^A02/A03/A08 | Verlegung (Standorthistorie), Entlassung (§301-Entlassungsgrund), Änderung |
| ADT^A40 Patientenzusammenführung | alter Patient `replaced-by`, alle Referenzen umgehängt, eine Transaktion |
| ORU^R01 Laborbefund | ISiKLaboruntersuchung (LOINC, UCUM, Referenzbereiche) + DiagnosticReport |
| ORM^O01, OML^O21 | ServiceRequest |
| MDM^T02/T10 | ISiKDokumentenMetadaten (KDL, IHE-XDS) + ISiKBinary |

Deutsche Besonderheiten: KVNR (Prüfziffer), IKNR, Fallnummer als Aufnahme- und Abrechnungsnummer, Vorsatzwort und Namenszusatz, Geschlecht „divers“ (gender-amtlich-de), Fachabteilungsschlüssel, §301-Aufnahmeanlass, -Aufnahmegrund und -Entlassungsgrund, ICD-10-GM mit Diagnosesicherheit und Seitenlokalisation (Z-Segment `ZDG`), KDL-Dokumentklassen.

## Wichtige Eigenschaften

- **Idempotent:** dieselbe Nachricht zweimal erzeugt keine Dubletten (bedingte Updates, deterministische IDs).
- **Reihenfolge-tolerant:** A08 vor A01, A01 nach A03, Laborbefund vor Aufnahme: alles definiert und getestet.
- **Dead-Letter-Queue und Replay:** fehlende Mappings scheitern laut mit genauer Feldangabe (`OBX[1]-3`). ConceptMap ergänzen, „Replay all“.
- **Integration as Code:** Kanäle als TypeScript-Definition, als OIE-XML versioniert, per REST-API deployt.
- **Getestet:** Unit-Tests, 223 Golden Files, Lauf im Rhino der Engine, HL7 FHIR Validator gegen ISiK 5.2.0 in der CI.

Alle Daten sind synthetisch.
