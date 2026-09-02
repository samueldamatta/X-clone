# ADR 0007 — Database bootstrap and service migrations are separate

**Status:** Accepted · 2026-08-31

## Context

Phase 1 shipped a database bootstrap,
[`infra/postgres/init/01-schemas.sql`](../../infra/postgres/init/01-schemas.sql). It creates
one extension, five schemas and five roles — and deliberately creates no tables.
Phase 2 adds the first tables, and they arrive from somewhere else entirely: a migration
inside the Identity service, run under `identity_svc`.

So two files write DDL into the same database, split along a line that is invisible from
either one. Unrecorded, the next person adding a table has a coin to flip, and the
intuitive answer — put it where the other schema objects already are — is the wrong one.

The line is not a preference. It is forced by two facts, both measured below against
`postgres:16-alpine` running this repository's own bootstrap script.

### A service role cannot create itself

Suppose the bootstrap is deleted and Identity's migration does the whole job. Its first
statement has to be `CREATE ROLE identity_svc`. Which role executes that statement?

Not `identity_svc` — it does not exist yet, which is what the statement is for. And even
once it does exist, it is refused:

```
xclone=> CREATE ROLE identity_svc_2 LOGIN PASSWORD 'x';
ERROR:  permission denied to create role
DETAIL:  Only roles with the CREATEROLE attribute may create roles.
```

The migration would therefore have to connect as `postgres`. But then the tool that builds
every table in the system runs as superuser, and the property the roles exist to establish
— `identity_svc` reaches `identity` and nothing else — is bypassed by the one process that
touches every schema. User story 40 in [#1](https://github.com/samueldamatta/X-clone/issues/1)
asks for the opposite: migrations run under the service's own restricted role.

The same cycle holds one level up. Creating a schema needs `CREATE` on the database, which
`identity_svc` does not have:

```
xclone=> CREATE SCHEMA sneaky;
ERROR:  permission denied for database xclone
```

### The bootstrap file runs exactly once, on an empty data directory

The postgres image executes `/docker-entrypoint-initdb.d/*` only while initialising a fresh
`PGDATA`. Adding a file there later is not a no-op that can be fixed on the next restart —
it never runs at all. Dropping a `99-later.sql` into the mounted directory and restarting
the container gives:

```
PostgreSQL Database directory appears to contain a database; Skipping initialization
```

and the table it declared does not exist. Not on that database, and not on any database
that already has a data directory. The only thing that replays the bootstrap is
`docker compose down -v`, which destroys every volume.

A table definition placed in the bootstrap therefore works exactly once, on exactly the
machines that happened to start from empty after it was written, and can never be evolved.
That is a schema that cannot have a second version — which is the one thing a schema is
guaranteed to need.

## Decision

Two DDL paths, divided by *what needs superuser and happens once* against *what a service
does repeatedly under its own role*.

**Bootstrap** — `01-schemas.sql`, executed as `postgres`, once per data directory:

- extensions (`citext`, which `identity.users.handle` depends on)
- the five schemas
- the five roles, their per-schema grants, their `search_path`
- revoking `CREATE` on `public`

**Migrations** — one ordered, reviewable set per service, executed as that service's own
role:

- tables, indexes, constraints
- every subsequent change to any of them

What makes this work is a single grant in the bootstrap:

```sql
GRANT USAGE, CREATE ON SCHEMA identity TO identity_svc;
```

`CREATE` on the schema — not on the database — is exactly enough for migrations and nothing
more. Verified in both directions:

| As `identity_svc` | Result |
|---|---|
| `CREATE TABLE users (id BIGINT PRIMARY KEY)` | `CREATE TABLE`, owner `identity_svc` |
| `CREATE TABLE tweet.tweets (id BIGINT PRIMARY KEY)` | `ERROR: permission denied for schema tweet` |
| `CREATE SCHEMA sneaky` | `ERROR: permission denied for database xclone` |
| `CREATE ROLE identity_svc_2` | `ERROR: permission denied to create role` |

The service can build everything it owns and cannot reach past its own boundary, which is
the whole arrangement in four lines.

## Consequences

**Gained**

- The bootstrap holds only what genuinely cannot be re-run, so nothing in it needs to
  evolve. Its contents and its once-only execution model finally agree
- Tables are owned by the service role that created them, so isolation holds at the
  boundary that actually enforces it rather than being asserted in review
- A schema change is an ordered migration file in the service's own repository directory —
  reviewable, replayable against an existing database, and deployable without touching
  infrastructure
- Adding a sixth service is one bootstrap edit for its schema and role, and its tables come
  with the service

**Paid**

- Two places to look for DDL, and a rule to remember about which is which. This document is
  the mitigation, and documents rot
- **Changing anything in the bootstrap costs every local database.** Adding a schema or a
  role means `pnpm reset`, because there is no other way to replay the file. Cheap now;
  it is exactly the operation that is not cheap in a shared environment
- The bootstrap is not itself versioned. Nothing detects a database created before a
  bootstrap change and warns that it is behind — it simply carries older grants until
  someone resets it
- Migrations run under a role that cannot create extensions, so any future extension is a
  bootstrap change with the full reset cost above, discovered at the moment a migration
  fails

**Mitigated by**

- `scripts/smoke.sh` asserts the boundary the bootstrap establishes, so a broken grant
  fails a check rather than surfacing as a confusing migration error
- The bootstrap script's own header comment states the rule at the point where someone
  would break it, which is the only place a warning gets read

## Alternatives considered

**Schema and role creation inside the migrations.** One DDL path, one tool, one ordering —
genuinely simpler to explain, and the layout most projects use.

Rejected on the cycle above: the migration that creates a role cannot run as that role, so
it runs as superuser, and migrations become the one component that can write anywhere. The
second cost is subtler and was measured. `CREATE SCHEMA` needs `CREATE` on the database,
and that privilege is not scoped to a name. Granting it to `identity_svc`:

```
xclone=> CREATE SCHEMA analytics;
CREATE SCHEMA
xclone=> SELECT nspname, pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='analytics';
 analytics | identity_svc
xclone=> GRANT CREATE ON SCHEMA analytics TO tweet_svc;
GRANT
```

The service can create any schema, owns what it creates, and as owner can grant others into
it. In a world where schemas arrive through migrations, whichever service migrates first
creates — and owns — the namespace, and nothing stops Identity's migration from creating
`tweet`. The bootstrap exists to decide that layout once, before any service runs.

**Table definitions in the bootstrap, migrations only for later changes.** Tempting because
day one is when the schema is fully known, and it puts the initial shape next to the roles
that guard it.

Rejected because the bootstrap runs on an empty data directory only. A developer who
already has a volume would never receive the initial tables — their database would start at
migration two, against tables that were never created. The failure would land on whoever
joined the project second, which is the worst possible place for it.

**Superuser everywhere, one role.** No cycle, because there is no boundary. Rejected in
Phase 1, and recorded under "Why service boundaries are enforced by the database" in
[`../concepts/local-environment.md`](../concepts/local-environment.md): with a single
`postgres` role, "no service reads another's tables" is an intention, and the join that
saves twenty minutes at 11pm is how a distributed monolith gets built.

## One thing that is not obvious

The bootstrap's `ALTER DEFAULT PRIVILEGES` lines do almost nothing for tables created by
migrations. Default privileges are recorded per grantor, and the bootstrap runs as
`postgres`:

```
 granted_by |  schema  |          defaclacl
------------+----------+------------------------------
 postgres   | identity | {identity_svc=arwd/postgres}
```

That entry applies to tables `postgres` creates in `identity`. Tables created by a migration
are owned by `identity_svc`, which needs no grant to read its own tables. So those lines are
a safety net for anything the superuser creates by hand, not the mechanism that gives the
service access to its own schema — the mechanism is ownership, and ownership comes from
running the migration as the service.

## See also

- [`../03-data-model.md`](../03-data-model.md) — the tables these migrations create
- [`../concepts/local-environment.md`](../concepts/local-environment.md) — why the roles
  exist at all, and the healthcheck caveat that made migrations an explicit step
- [`0006-drizzle-as-the-orm.md`](0006-drizzle-as-the-orm.md) — the tool that generates the
  migrations
- [`../../infra/postgres/init/01-schemas.sql`](../../infra/postgres/init/01-schemas.sql) —
  the bootstrap itself
