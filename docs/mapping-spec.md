# Mapping specification: HL7 v2.5 → ISiK Stufe 5 (FHIR R4)

Target: package `de.gematik.isik` **5.2.0** (ISiK Stufe 5, technical correction of October 2026), with `de.basisprofil.r4` 1.5.4.
Implementation: [`mapper/src/mappers`](../mapper/src/mappers). Expected output for every case: [`testdata/golden`](../testdata/golden).

Conventions used below:

- **MS**: Must Support in the ISiK profile. **min 1**: required by the profile.
- `cfg.systems.*`: site identifier namespaces from [`mapper/src/config.ts`](../mapper/src/config.ts) (demo site *Klinikum Musterstadt*, `https://fhir.klinikum-musterstadt.example/sid/...`).
- Timestamps without an offset are interpreted as **Europe/Berlin** local time (EU daylight-saving rules) because FHIR requires an offset on every `dateTime` with a time.
- `""` (HL7 explicit null) is treated as empty.

## Messages and resources

| Inbound v2 | FHIR output | Write semantics |
| --- | --- | --- |
| ADT^A01, A04 (admit, register) | ISiKPatient, ISiKKontaktGesundheitseinrichtung (Encounter), ISiKVersicherungsverhaeltnisGesetzlich (Coverage), ISiKAbrechnungsfall (Account), ISiKDiagnose (Condition) per DG1 | conditional update; Patient and Encounter read-reconcile-write |
| ADT^A02 (transfer) | Encounter location change, prior location kept as `completed` | as above |
| ADT^A03 (discharge) | Encounter `finished` with `period.end` and Entlassungsgrund | as above |
| ADT^A08 (update) | Patient (+ Encounter when PV1-19 is present) | as above |
| ADT^A40 (merge) | survivor Patient gets the retired number as `use=old`; retired Patient `active=false` + `link replaced-by`; every reference moved | one transaction with If-Match on every rewritten resource |
| ORU^R01 | ISiKLaboruntersuchung (Observation) per OBX, DiagnosticReport per OBR | Patient conditional create only; Observations/report upsert |
| ORM^O01, OML^O21 | ServiceRequest per ORC | upsert by placer order number |
| MDM^T02, T10 | ISiKDokumentenMetadaten (DocumentReference) + ISiKBinary | upsert by TXA-12; T10 supersedes TXA-13 |
| anything else | not written; status `IGNORED` | — |

Every message also writes one **Provenance** (`Provenance/hl7v2-<hash of facility|application|control id>`): `target` = all resources of the message, `occurredDateTime` = EVN-2 or MSH-7, `entity.what.identifier` = the message key. The deterministic id makes replays update instead of duplicate.

ISiK Stufe 5 has no profile for DiagnosticReport (laboratory) or ServiceRequest; those are base R4 resources.

## Patient — ISiKPatient (PID)

| v2 | FHIR | ISiK | Notes |
| --- | --- | --- | --- |
| PID-3 (CX-5 `PI`/`MR`/`PN`/empty, CX-4 own authority) | `identifier:Patientennummer` (type v2-0203 `MR`, `cfg.systems.patient`) | min 1, MS | business key; missing → `MISSING_REQUIRED_FIELD PID-3` |
| PID-3 (CX-5 `KVZ10`/`GKV`) or IN1-36 | `identifier:VersichertenId` (`http://fhir.de/sid/gkv/kvid-10`, type `KVZ10`) | MS | format `^[A-Z][0-9]{9}$`; invalid → warning, dropped |
| PID-5 (XPN-7 `L`) | `name:Name` use `official`, `family`, `given` (+ XPN-3 middle names) | min 1, MS | family and given required |
| XPN-1 FN subcomponents `surname&own prefix&own surname` | `family` + extensions `humanname-own-prefix` (Vorsatzwort), `humanname-own-name` | MS | "von Müller&von&Müller" |
| XPN-6 degree / XPN-5 "Dr…", "Prof…" | `prefix` with `iso21090-EN-qualifier = AC` | MS | |
| PID-5 (XPN-7 `B`/`M`) | `name:Geburtsname` use `maiden`, family only | MS | given/prefix are `max 0` in ISiK |
| PID-7 | `birthDate` | min 1 | missing → `_birthDate` data-absent-reason `unknown` + warning |
| PID-8 `M`/`F`(`W`)/`U`/`A`/`N` | `gender` male/female/unknown | min 1 | |
| PID-8 `D` / `X` | `gender=other` + `gender-amtlich-de` D (divers) / X (unbestimmt) | isik-pat-1 | |
| PID-11 (XAD, SAD components) | `address:Strassenanschrift` type `both`, line + ADXP streetName/houseNumber, city, postalCode, country | line, city, postalCode, country min 1 | country D/DEU → `DE`; incomplete address → warning, skipped |
| PID-11 "Postfach …" | `address:Postfach` type `postal`, ADXP postBox | | |
| PID-13 / PID-14 (XTN) | `telecom` phone/email/fax, use home/work/mobile | MS | XTN-12 or country/area/local |
| PID-29 / PID-30 | `deceasedDateTime` / `deceasedBoolean` | MS | |

Lab, order and document messages create the Patient only if it does not exist yet (`POST` + `If-None-Exist`). ADT is the only source of demographics.

## Encounter — ISiKKontaktGesundheitseinrichtung (PV1, PV2, EVN)

| v2 | FHIR | ISiK | Notes |
| --- | --- | --- | --- |
| PV1-19 | `identifier:Aufnahmenummer` (type `VN`, `cfg.systems.encounter`) | MS | business key (Fallnummer); missing → error (A08: patient only) |
| event | `status`: A01/A02/A04 `in-progress`, A03 `finished`, A08 `finished` if PV1-45 else `in-progress` | MS, required binding EncounterStatusDe | status never moves backwards (see below) |
| PV1-2 `I`/`B` → `IMP`, `O`/`E`/`R` → `AMB`, `P` → `PRENC` | `class` (v3-ActCode) | MS, required binding EncounterClassDE | other values → `INVALID_VALUE PV1-2` |
| — | `type:Kontaktebene` = `abteilungskontakt` | min 1 (pattern) | the ISiK contact is department level |
| PV1-18 (kontaktart-de code) | `type:KontaktArt` | MS | only when PV1-18 carries a kontaktart-de code |
| PV1-10 (4 digits) | `serviceType` Fachabteilungsschlüssel (DKG) | MS | 4 alphanumerics → Fachabteilungsschlüssel-erweitert |
| PV1-44 / PV1-45 | `period.start` / `period.end` | ISiK-enc-2, -5 | missing start/end → EVN-2/MSH-7 with an issue |
| PV1-3 (PL) | `location:Station` (`wa`), `:Zimmer` (`ro`), `:Bettenstellplatz` (`bd`), identifier + display | MS | `completed` when finished |
| PV1-6 (A02) | prior locations with status `completed` | | |
| PV1-4 (§301 Aufnahmeanlass E/Z/N/R/V/A/G/B) | `hospitalization.admitSource` | MS | interface contract: PV1-4 carries the §301 code |
| PV2-3 (4 digits) | extension `Aufnahmegrund` (1st+2nd, 3rd, 4th digit) | MS | §301 Aufnahmegrund |
| PV1-36 (3 digits) | `hospitalization.dischargeDisposition.extension:Entlassungsgrund` | MS | §301 Entlassungsgrund |
| DG1 (same message) | `diagnosis.condition`, `use` Diagnosetyp (`referral-diagnosis` for DG1-6 `A`, else `treatment-diagnosis`), `department-main-diagnosis` for rank 1, `rank` = DG1-15 | MS | |
| PV1-19 | `account` (reference + identifier) → Account | MS | |
| site config | `serviceProvider.identifier` (IKNR) + `display` | MS | |

## Account — ISiKAbrechnungsfall

| v2 | FHIR | Notes |
| --- | --- | --- |
| PV1-19 | `identifier:Abrechnungsnummer` (type `AN`, `cfg.systems.account`) | Fallnummer = Abrechnungsnummer (one case number in the KIS) |
| — | `status=active`, `subject` → Patient, `coverage` → Coverage (priority 1) | |

## Coverage — ISiKVersicherungsverhaeltnisGesetzlich (IN1)

| v2 | FHIR | Notes |
| --- | --- | --- |
| IN1-15 | only `GKV` is mapped; PKV/SEL/BG → information issue, skipped | interface contract |
| IN1-3 (9 digits) | `payor.identifier` (IKNR, type `XX`) | invalid → `INVALID_VALUE IN1-3` |
| IN1-4 | `payor.display` (min 1) | |
| IN1-36 / PID-3 KVNR | `subscriber.identifier` (kvid-10) when IN1-17 is `SEL`/empty | also completes `Patient.identifier:VersichertenId` |
| IN1-12 / IN1-13 | `period` | |
| — | `type` GKV, `beneficiary` → Patient, `identifier` = Patientennummer-IKNR | business key |

## Condition — ISiKDiagnose (DG1 + ZDG)

| v2 | FHIR | Notes |
| --- | --- | --- |
| DG1-3.1 | `code.coding:ICD-10-GM` code; trailing †/*/! (or `+`) → extension Mehrfachcodierungs-Kennzeichen | must match the ISiK ICD regex |
| DG1-3.3 | must be ICD-10-GM (`I10`, `I10G`, `ICD10GM`) | otherwise `TERMINOLOGY_UNMAPPED` |
| DG1-3.7 | `coding.version` (min 1 in CodingICD10GM), default `2026` | |
| DG1-3.2 / DG1-4 | `coding.display`, `code.text` | |
| ZDG-2 (A/G/V/Z) | extension Diagnosesicherheit; `verificationStatus` refuted/confirmed/provisional; Z → `clinicalStatus=resolved` | site Z-segment, see below |
| ZDG-3 (R/L/B) | extension Seitenlokalisation | |
| DG1-5 | `recordedDate` (min 1) | fallback event time + issue |
| DG1-20 or Fallnummer-code-type | `identifier` (`cfg.systems.condition`) | business key |
| — | `subject` → Patient, `encounter` → Encounter of the same message | isik-con1 |

**ZDG segment (site convention).** DG1 has no field for the German Diagnosesicherheit and Seitenlokalisation, so the KIS sends them in a Z-segment that directly follows its DG1: `ZDG|<set id>|<A/G/V/Z>|<R/L/B>`.

## Observation — ISiKLaboruntersuchung (ORU^R01 OBX)

| v2 | FHIR | Notes |
| --- | --- | --- |
| OBX-3 (`LN`) or OBX-3.4-6 (`LN`) | `code.coding:loinc` (min 1) | |
| OBX-3 local code | `$translate` with ConceptMap `labor-lokal-zu-loinc` → LOINC, local coding kept | unmapped → `TERMINOLOGY_UNMAPPED OBX[n]-3` (dead letter, fix the map, replay) |
| OBX-2 `NM` | `valueQuantity` value; decimal commas accepted | |
| OBX-2 `SN` (`<^0.5`) | `valueQuantity` with `comparator` | |
| OBX-2 `ST`/`TX`/`FT` | `valueString` (repetitions = lines) | |
| OBX-2 `CE`/`CWE` | `valueCodeableConcept` | |
| OBX-6 | `valueQuantity.system=UCUM` + `code` (min 1); `UCUM`-marked units are used as they are, others go through ConceptMap `einheiten-lokal-zu-ucum` (case-insensitive) | unmapped → `TERMINOLOGY_UNMAPPED OBX[n]-6` |
| OBX-7 `a-b`, `<b`, `>a` | `referenceRange.low/high` (UCUM quantities) + `text` | anything else: text only |
| OBX-8 | `interpretation` (v3-ObservationInterpretation H, L, HH, LL, N, A, AA, <, >) | |
| OBX-11 | `status` (F final, C corrected, P/R/S preliminary, I registered, X cancelled, D/W entered-in-error) | X → `dataAbsentReason=not-performed` |
| OBX-14, else OBR-7 | `effectiveDateTime` | |
| OBR-22 | `issued` (instant) | |
| NTE after OBX | `note` | |
| SPM-2 | `specimen.identifier` | |
| OBR-3 (filler) + OBX-3 + OBX-4 | `identifier` (`cfg.systems.observation`) | re-sent results update in place |
| PV1-19 | `encounter` as conditional reference `Encounter?identifier=…` | delivery waits until it exists |

DiagnosticReport per OBR: `identifier` = filler order number, `basedOn` = placer order number (logical reference), `status` from OBR-25, `category` `LAB`, `code` from OBR-4 (LOINC when mapped), `result` → the Observations, NTE after OBR → `conclusion`.

## ServiceRequest (ORM^O01, OML^O21)

| v2 | FHIR |
| --- | --- |
| ORC-2 / OBR-2 | `identifier` PLAC (business key) |
| ORC-3 / OBR-3 | `identifier` FILL |
| ORC-1 + ORC-5 | `status`: NW/XO → active; CA/OC/DC/OD → revoked; HD/OH → on-hold; SC + CM → completed |
| TQ1-9 / ORC-7.6 / OBR-27.6 | `priority` (S stat, A asap, R routine, T urgent) |
| OBR-4 | `code` (LOINC via ConceptMap when known + local coding) |
| ORC-9 | `authoredOn` |
| ORC-12 | `requester.display` |
| NTE | `note` |
| OML | `category` SNOMED CT 108252007 *Laboratory procedure* |

## DocumentReference — ISiKDokumentenMetadaten + ISiKBinary (MDM^T02/T10)

| v2 | FHIR | ISiK |
| --- | --- | --- |
| TXA-12 | `masterIdentifier` (`cfg.systems.document`) | min 1 |
| TXA-2 (`KDL`) or local code → ConceptMap `dokumenttyp-lokal-zu-kdl` | `type.coding:KDL` (code + display) | min 1, required binding |
| KDL → DVMD ConceptMap `kdl-ihe-typecode` | `type.coding:XDS` | MS |
| KDL → DVMD ConceptMap `kdl-ihe-classcode` | `category.coding:XDS` | min 1 |
| TXA-19 AV/OB/CA | `status` current/superseded/entered-in-error | MS |
| TXA-17 AU/LA → final; DO/IP/IN/PA/DI → preliminary | `docStatus` | MS |
| TXA-18 V/R/U | `securityLabel` (v3-Confidentiality V/R/N) | min 1 |
| TXA-4 | `date` (instant) | |
| TXA-5 (else TXA-9) | `author.display` | MS |
| OBX-5 (ED, Base64, may be split over several OBX) | `Binary` (`PUT Binary/doc-<hash>`), `content.attachment.url` | Binary.data min 1 |
| OBX-5.2/5.3 (`AP`/`PDF`) | `attachment.contentType` | min 1 |
| site config | `attachment.language` = de-DE | min 1 |
| TXA-16 or KDL display | `attachment.title` | min 1 |
| TXA-6, else TXA-4 | `attachment.creation` | min 1 |
| — | `content.format` = `urn:ihe:iti:xds:2017:mimeTypeSufficient` | min 1 |
| — | `context.facilityType` = KHS (Krankenhaus) | min 1 |
| PV1-19 | `context.encounter` (conditional reference) | |
| TXA-13 (T10 required) | `relatesTo` replaces; the parent document becomes `superseded` | |

## Merge (ADT^A40)

PID is the surviving patient, MRG-1 the retired Patientennummer. In one transaction:

1. the survivor is written with the retired number as an extra identifier with `use = old`, and a `link replaces` to the retired record;
2. the retired Patient becomes `active = false` with `link replaced-by` → survivor;
3. every Encounter, Account, Coverage, Condition, Observation, DiagnosticReport, ServiceRequest and DocumentReference that referenced the retired Patient is rewritten to the survivor (versioned PUT with If-Match).

Patient lookups use `Patient?identifier=…&active:not=false`, so a late message that still carries the retired number resolves to the survivor and never overwrites it. Replaying the merge is a no-op.

## Out-of-order and replay rules

| Situation | Behaviour |
| --- | --- |
| Same message twice (KIS retransmit, replay) | conditional updates and deterministic ids: no duplicates, no new versions |
| ADT older than the last applied event for the patient (EVN-2 vs Provenance) | demographics are kept, issue `OUT_OF_ORDER_STALE_DEMOGRAPHICS` |
| A01/A02/A08 after A03 | Encounter stays `finished` with its end date, issue `OUT_OF_ORDER_STATUS_KEPT_FINISHED` |
| A08 before A01 | A08 creates the Encounter, the A01 updates it |
| ORU/ORM/MDM before the Encounter exists | delivery returns `DEPENDENCY_MISSING`, retried with back-off for up to 10 minutes, then dead letter |
| ADT message without DG1, IN1 or locations | diagnoses, account, admit/discharge details and location history from the stored version are kept |
