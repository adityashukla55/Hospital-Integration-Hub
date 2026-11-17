#!/usr/bin/env bash
# Validates the hub's golden output against ISiK Stufe 5 with the official
# HL7 FHIR Validator (https://github.com/hapifhir/org.hl7.fhir.core).
#
#   tools/validate.sh            # golden cases
#   tools/validate.sh --corpus   # golden cases + the 200+ message corpus
#
# Needs Java 17+ locally, or Docker (falls back to eclipse-temurin:21-jre).
# Terminology checks against tx.fhir.org are disabled (-tx n/a): German code
# systems (ICD-10-GM, KDL, IHE-D) are not served there; structure, profiles,
# invariants and bindings to package-local value sets are still checked.
set -euo pipefail
cd "$(dirname "$0")/.."

IG="de.gematik.isik#5.2.0"
# not a declared ISiK dependency, but bound by ISiKDokumentenMetadaten.content.format
IG_EXTRA="ihe.formatcode.fhir#1.4.0"
CACHE=".cache/validator"
JAR="$CACHE/validator_cli.jar"
IN=".cache/validate/in"
REPORT="reports/validation"
mkdir -p "$CACHE" "$REPORT"

if [ ! -f "$JAR" ]; then
  echo "downloading HL7 FHIR Validator..."
  curl -sSfL -o "$JAR" https://github.com/hapifhir/org.hl7.fhir.core/releases/latest/download/validator_cli.jar
fi

node mapper/scripts/extract-for-validation.ts "$IN" "$@"

ARGS=("$IN" -version 4.0.1 -ig "$IG" -ig "$IG_EXTRA" -tx n/a -output "$REPORT/outcome.json")
if command -v java >/dev/null 2>&1 && java -version 2>&1 | grep -qE 'version "(1[7-9]|2[0-9])'; then
  java -Xmx3g -jar "$JAR" "${ARGS[@]}" | tee "$REPORT/validator.log"
else
  docker run --rm -v "$PWD:/work" -w /work -v "$PWD/.cache/fhir:/root/.fhir" eclipse-temurin:21-jre \
    java -Xmx3g -jar "$JAR" "${ARGS[@]}" | tee "$REPORT/validator.log"
fi

node -e '
const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const outcomes = b.resourceType === "Bundle" ? b.entry.map(e => e.resource) : [b];
let errors = 0, warnings = 0;
for (const oo of outcomes) for (const i of oo.issue || []) {
  if (i.severity === "error" || i.severity === "fatal") { errors++; console.log("ERROR", (i.expression || [""])[0], "-", i.details?.text || i.diagnostics); }
  else if (i.severity === "warning") warnings++;
}
console.log(`\n${outcomes.length} resources: ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
' "$REPORT/outcome.json"
