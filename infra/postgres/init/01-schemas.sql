-- Schemas, roles and extensions. No tables.
--
-- Tables belong to the service that owns them and arrive through that service's
-- migrations (identity in Phase 2, tweet and graph in Phase 3). Putting DDL here
-- would work exactly once: the second time, the container already has a data
-- volume and Postgres skips /docker-entrypoint-initdb.d entirely.
--
-- This file runs only on an empty data directory. `docker compose down -v` is
-- what replays it.
--
-- Why the split exists, and what putting schema and role creation in migrations
-- would have cost: docs/adr/0007-bootstrap-versus-service-migrations.md

-- CITEXT backs identity.users.handle: case-insensitive by type rather than by
-- every query remembering to call lower(). See docs/03-data-model.md.
CREATE EXTENSION IF NOT EXISTS citext;

-- One schema per service. Locally this is one Postgres instance; in production
-- they are separate ones. Application code cannot tell the difference, because
-- what enforces the boundary is the grant table below, not the topology.
CREATE SCHEMA IF NOT EXISTS identity;
CREATE SCHEMA IF NOT EXISTS graph;
CREATE SCHEMA IF NOT EXISTS tweet;
CREATE SCHEMA IF NOT EXISTS media;
CREATE SCHEMA IF NOT EXISTS notification;

-- Search owns no Postgres schema at all: its state is an OpenSearch index,
-- rebuildable by replaying tweet.created from offset zero.

-- One role per service, each able to reach its own schema and nothing else.
--
-- This is the part that turns "no service reads another's tables" from a code
-- review convention into something the database refuses. Without it, the first
-- late-night debugging session discovers that tweet_svc can happily
-- SELECT FROM identity.users, and the service boundary quietly stops existing.
--
-- Passwords are literal and weak on purpose: this instance is bound to a local
-- compose network and is destroyed by `down -v`. Nothing here is a secret, and
-- pretending otherwise by templating them would suggest it could be reused.
DO $$
DECLARE
  svc TEXT;
BEGIN
  FOREACH svc IN ARRAY ARRAY['identity', 'graph', 'tweet', 'media', 'notification']
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = svc || '_svc') THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', svc || '_svc', svc || '_svc_dev');
    END IF;

    -- USAGE lets the role see the schema; CREATE lets its migrations build in it.
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', svc, svc || '_svc');

    -- Tables do not exist yet, so grant on what the migrations will create later.
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
      svc, svc || '_svc');
    EXECUTE format(
      'ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
      svc, svc || '_svc');

    -- Resolve unqualified names to the service's own schema, so a query that
    -- forgets to qualify a table fails loudly instead of finding a public one.
    EXECUTE format('ALTER ROLE %I SET search_path TO %I', svc || '_svc', svc);
  END LOOP;
END
$$;

-- Nothing should live in public, and no service should be able to put it there.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
