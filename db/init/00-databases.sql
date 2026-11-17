-- One Postgres instance, three databases:
--   oie  - Open Integration Engine's own store (channels, message history)
--   hapi - HAPI FHIR JPA server
--   hub  - hub message store: raw v2 messages, processing status, dead letters
-- Passwords are local-development defaults; override them in .env.

CREATE ROLE oie LOGIN PASSWORD 'oie';
CREATE DATABASE oie OWNER oie;

CREATE ROLE hapi LOGIN PASSWORD 'hapi';
CREATE DATABASE hapi OWNER hapi;

CREATE ROLE hub LOGIN PASSWORD 'hub';
CREATE DATABASE hub OWNER hub;

-- read-only role for Grafana panels
CREATE ROLE grafana LOGIN PASSWORD 'grafana';
