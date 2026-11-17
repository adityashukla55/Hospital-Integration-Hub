\connect hub hub

CREATE SCHEMA IF NOT EXISTS hub AUTHORIZATION hub;
SET search_path = hub;

-- Every inbound v2 message, stored before processing (store-and-forward).
-- One row per delivery attempt chain; a replay creates a new row that
-- points back to the original via replay_of.
CREATE TABLE message (
  id                  bigserial PRIMARY KEY,
  received_at         timestamptz NOT NULL DEFAULT now(),
  sending_application text,
  sending_facility    text,
  control_id          text,
  message_type        text,          -- e.g. ADT^A01
  raw                 text NOT NULL,
  -- RECEIVED -> MAPPED -> DELIVERED, or IGNORED / RETRYING / FAILED
  status              text NOT NULL DEFAULT 'RECEIVED',
  status_code         text,
  status_message      text,
  issues              jsonb,
  fhir_locations      jsonb,
  attempts            integer NOT NULL DEFAULT 0,
  first_attempt_at    timestamptz,
  next_attempt_at     timestamptz,
  mapped_at           timestamptz,
  delivered_at        timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  replay_of           bigint REFERENCES message(id),
  oie_message_id      bigint
);
CREATE INDEX message_received_idx ON message (received_at DESC);
CREATE INDEX message_status_idx ON message (status, updated_at DESC);
CREATE INDEX message_key_idx ON message (sending_facility, sending_application, control_id);

-- Messages that could not be processed, with the stage and a stable error code.
CREATE TABLE dead_letter (
  id          bigserial PRIMARY KEY,
  message_id  bigint NOT NULL REFERENCES message(id),
  stage       text NOT NULL CHECK (stage IN ('TRANSFORM', 'DELIVER')),
  code        text NOT NULL,
  message     text NOT NULL,
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  replayed_at timestamptz,
  replayed_as bigint REFERENCES message(id)
);
CREATE INDEX dead_letter_open_idx ON dead_letter (created_at DESC) WHERE replayed_at IS NULL;

-- Latency per stage, for dashboards.
CREATE VIEW message_latency AS
SELECT id, message_type, status, received_at,
       EXTRACT(EPOCH FROM (mapped_at - received_at)) * 1000    AS map_ms,
       EXTRACT(EPOCH FROM (delivered_at - received_at)) * 1000 AS end_to_end_ms
FROM message;

GRANT USAGE ON SCHEMA hub TO grafana;
GRANT SELECT ON ALL TABLES IN SCHEMA hub TO grafana;
ALTER DEFAULT PRIVILEGES IN SCHEMA hub GRANT SELECT ON TABLES TO grafana;
