# ADR 0005 — Snowflake IDs for every entity

**Status:** Accepted · 2026-08-20

## Context

Every entity needs an identifier, generated across multiple services and eventually
multiple database shards, with no central coordinator on the write path.

Timelines additionally need a *sort key*. A home timeline merges tweet ids from several
Redis lists and must order them chronologically — ideally without fetching each tweet to
read its timestamp.

## Decision

64-bit Snowflake IDs, the scheme Twitter built for exactly this problem:

```
 1 bit    41 bits              10 bits        12 bits
┌──────┬───────────────────┬──────────────┬──────────────┐
│unused│ ms since epoch    │ machine id   │ sequence     │
└──────┴───────────────────┴──────────────┴──────────────┘
         ~69 years           1,024 nodes    4,096 per ms per node
```

~4.2M ids/second across the fleet, generated locally with no network call.

## Consequences

**Gained**

- **Sorting by id is sorting by time.** The timeline merge-sort is a numeric comparison —
  no timestamp column, no secondary index, no hydration needed before ordering
- Zero coordination: no database round trip, no lock, no sequence server
- Cursor pagination for free: `WHERE id < :cursor LIMIT 50`, with none of `OFFSET`'s
  skipped-or-repeated-row bugs
- Sequential inserts keep B-tree pages dense
- 8 bytes — half a UUID. Fits `BIGINT` and Redis integer-encoded lists, which is what keeps
  timeline memory at 8 bytes per entry
- The shard key is already inside the id, so sharding later is a routing change

**Paid**

- **Machine ids must be allocated and kept unique.** Two nodes sharing one silently
  generate colliding ids
- **Clock skew breaks the guarantee.** An NTP correction moving the clock backwards can
  reissue ids. Requires explicit handling: refuse to issue, or wait out the drift
- Ids leak creation time and rough volume — acceptable for public tweets, worth remembering
  for anything private
- Must be serialised as **strings** in JSON; JavaScript loses precision above 2^53−1

**Mitigated by**

- Machine ids from the Kubernetes StatefulSet ordinal (Phase 11); a fixed per-container id
  from compose before that
- The generator refuses to issue ids when it detects the clock moving backwards, rather
  than risking duplicates
- Cross-language tests asserting Go and TypeScript agree on encoding and decoding

## Alternatives considered

**Postgres `BIGSERIAL`.** Simple, guaranteed unique. Rejected: requires coordination with a
single database, becomes a write bottleneck, and cannot survive sharding — two shards would
issue the same value.

**UUID v4.** Unique with no coordination. Rejected because it is *random*: no time
ordering (so the timeline merge would need timestamps), random B-tree inserts fragment
pages and degrade write throughput, and 16 bytes doubles index size and timeline memory.

**UUID v7.** Time-ordered and standardised — genuinely the modern answer, and a reasonable
alternative. Rejected here for 128 bits against 64: at 3M materialised timelines × 400
entries, that difference is roughly 10 GB of Redis. Snowflake is also what Twitter actually
built, which matters for a project whose purpose is to understand Twitter.

## See also

- [`concepts/snowflake-ids.md`](../concepts/snowflake-ids.md)
- [`03-data-model.md`](../03-data-model.md#identifiers)
