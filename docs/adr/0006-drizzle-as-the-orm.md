# ADR 0006 — Drizzle as the ORM for the NestJS services

**Status:** Accepted · 2026-08-31

## Context

Four NestJS services own a Postgres schema: identity, tweet, media and notification. (The
`graph` schema exists too, but Go owns it and will reach it without an ORM; search holds no
Postgres schema at all.) Those four need a way to describe tables, evolve them through
reviewable migrations, and query them without hand-writing every statement.

Two properties of this system constrain the choice more than developer preference does.

**Partial indexes are load-bearing here, not an optimisation.**
[`../03-data-model.md`](../03-data-model.md) declares four of them — on sessions, twice on
tweets, and on the outbox. The outbox one carries the most weight: the publisher polls "what
is unpublished" continuously, so without a partial index it pays to skip every
already-published row on every poll, forever.

**Identifiers are 64-bit and must reach JSON as strings.**
[ADR 0005](0005-snowflake-ids.md) chose Snowflake ids, which live in a `BIGINT`.
JavaScript's `Number.MAX_SAFE_INTEGER` is 2^53−1, so a Snowflake serialised as a JSON
number is silently corrupted. [`../04-api-contracts.md`](../04-api-contracts.md) specifies
strings.

A third constraint comes from this repository's own layering rule: `domain/` may not import
from a framework. An ORM that wants decorators on entity classes either violates that or
forces a parallel set of persistence entities plus mapping.

## Decision

**Drizzle**, adopted after a spike that verified both constraints against a running Postgres
rather than against documentation.

Snowflake columns are declared through a custom column type. It works without a global JSON
serialiser patch because `node-postgres` already returns `int8` as a string, precisely to
avoid the precision loss above — the custom type passes that through rather than converting
anything:

```ts
const snowflake = customType<{ data: string; driverData: string }>({
  dataType: () => 'bigint',
});
```

### What the spike measured

Verified against drizzle-orm 0.45.2, drizzle-kit 0.31.10, `pg` 8.23.0 and Postgres 16. A
gate whose result is not scoped to a version cannot be re-run when an upgrade threatens it.

**Partial indexes survive generation.** drizzle-kit emitted the predicate intact, including
on the descending sort key:

```sql
CREATE INDEX "outbox_unpublished_idx" ON "spike"."outbox" USING btree ("id")
  WHERE "spike"."outbox"."published_at" is null;
CREATE INDEX "tweets_author_idx" ON "spike"."tweets" USING btree ("author_id","id" DESC NULLS LAST)
  WHERE "spike"."tweets"."deleted_at" is null;
```

The migration applied cleanly, and Postgres reported the indexes as genuinely partial rather
than as full indexes with an unused predicate.

**A partial index is proportional to the backlog, not to history.** At 50,000 outbox rows
of which 500 were unpublished — roughly the ratio a healthy publisher maintains:

| | Size |
|---|---|
| `outbox_unpublished_idx` (partial) | 32 kB |
| `outbox_pkey` (full) | 1112 kB |

The planner chose the partial index for the publisher's poll query. That 35× difference is
the whole argument: the index the publisher scans every second stays proportional to the
backlog rather than to everything ever published.

**Snowflakes survive the round trip.** `1847362819374387201` — nineteen digits, far above
`Number.MAX_SAFE_INTEGER` — was written, read back as a JavaScript `string` equal digit for
digit, and serialised by a plain `JSON.stringify` as `"id":"1847362819374387201"`, quoted,
with no serialiser patch anywhere.

The spike itself was throwaway and has been deleted, per its ticket. What is recorded above
is what a reader needs to re-run it: the versions, the column type, and the generated SQL.

## Consequences

**Gained**

- Partial indexes are declared in the schema and generated correctly, so the schema file
  stays the truth about the database
- Snowflake ids are strings from the driver to the JSON response, with no serialisation
  layer to forget
- The domain layer stays free of framework imports without a parallel entity set
- No binary query engine to ship in the image or debug when it misbehaves
- Generated migrations are plain SQL, reviewable and editable

**Paid**

- Drizzle is younger than the alternatives, with a smaller community and far fewer NestJS
  examples to copy. Problems will more often need solving rather than searching
- More SQL written by hand than Prisma would require — a benefit for a learning project, a
  cost for a delivery one
- The custom Snowflake column type is ours to maintain, and every service must remember to
  use it. A plain `bigint` column would compile fine and corrupt data above 2^53−1
- The decision is reversible only at a cost that grows with every migration written

**Mitigated by**

- The fallback is TypeORM, and the trigger would be Drizzle failing on something structural
  rather than merely inconvenient
- The Snowflake column type lives in one shared place, so "remember to use it" is a review
  question about imports rather than about column definitions

## Alternatives considered

**TypeORM** — the conventional NestJS choice, and it maps `BIGINT` to `string` with no
configuration at all, which is exactly what is wanted. Rejected because it wants decorators
on entity classes, which either puts framework imports in the domain layer or requires
maintaining separate persistence entities and mapping between them. Its migration tooling
also has an uneven history. It remains the fallback.

**Prisma** — the best developer experience of the three, and rejected on the constraint that
matters most here: it does not express partial indexes in its declarative schema. The
workaround is hand-edited migration SQL, which leaves the schema file describing a database
that does not exist — and the schema file being trustworthy is most of what Prisma is for.
Its client also surfaces `BIGINT` as a JavaScript `BigInt`, which `JSON.stringify` refuses
to serialise, requiring a global patch on a value type used in every response.

**Kysely, or no ORM at all** — maximum control and no abstraction to fight. Rejected as
disproportionate: it would mean hand-writing every query in four services to gain control
this system does not need outside the hot path, and the hot path is Go anyway.

## See also

- [`0005-snowflake-ids.md`](0005-snowflake-ids.md) — why identifiers are 64-bit
- [`../03-data-model.md`](../03-data-model.md) — the schemas and the four partial indexes
- [`../04-api-contracts.md`](../04-api-contracts.md) — why ids serialise as strings
