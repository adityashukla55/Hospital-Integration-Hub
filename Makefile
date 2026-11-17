.DEFAULT_GOAL := help
COMPOSE := docker compose

help: ## list targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## install Node dev dependencies
	npm ci

build: ## build the mapper bundle and regenerate channel XML
	npm run build

test: ## unit, golden and engine tests (no Docker needed)
	npm test

up: ## start the whole stack (first start installs ISiK into HAPI: ~5-10 min)
	$(COMPOSE) up -d --build
	@echo "waiting for channels to be deployed..."
	@$(COMPOSE) wait engine-init >/dev/null && echo "ready: ops console http://localhost:8088  FHIR http://localhost:8080/fhir  Grafana http://localhost:3000  OIE https://localhost:8443"

down: ## stop the stack (keeps data)
	$(COMPOSE) down

clean: ## stop the stack and delete all data volumes
	$(COMPOSE) down -v

deploy: ## re-deploy channels and code templates into the running engine
	OIE_URL=https://localhost:8443 FHIR_BASE_URL=http://localhost:8080/fhir node engine/tools/deploy.ts --seed-terminology

demo: ## send the hand-written demo scenario (admission, labs, transfer, letter, discharge, merge)
	cd simulator && node src/cli.ts send \
	  ../testdata/golden/adt-a01-admission.hl7 ../testdata/golden/oml-o21-lab-order.hl7 \
	  ../testdata/golden/oru-r01-electrolytes.hl7 ../testdata/golden/adt-a02-transfer-icu.hl7 \
	  ../testdata/golden/mdm-t02-discharge-letter.hl7 ../testdata/golden/mdm-t10-replacement.hl7 \
	  ../testdata/golden/adt-a03-discharge.hl7 ../testdata/golden/oru-r01-unmapped-code.hl7 \
	  ../testdata/golden/adt-a31-ignored.hl7

corpus: ## regenerate the synthetic corpus and its golden files
	npm run corpus && npm run golden:update

replay-corpus: ## send the whole synthetic corpus through MLLP
	cd simulator && node src/cli.ts replay --dir ../testdata/corpus

load: ## load test: 50 msg/s for 60 s (RATE=, SECONDS=)
	cd simulator && node src/cli.ts load --rate $${RATE:-50} --seconds $${SECONDS:-60}

validate: ## validate golden output with the HL7 FHIR Validator against ISiK 5.2.0
	tools/validate.sh

logs: ## follow engine and FHIR server logs
	$(COMPOSE) logs -f oie hapi engine-init

.PHONY: help install build test up down clean deploy demo corpus replay-corpus load validate logs
