# Snowflake IDs

## The problem

Generate unique identifiers across several services and, later, several database shards —
with no central coordinator on the write path.

And a second requirement that is easy to miss: the home timeline merges tweet ids from
multiple Redis lists and must order them **chronologically**. Ideally without fetching each
tweet just to read its timestamp.

So the identifier needs to be a *sort key* as well as a name.

## Why the obvious answers fail

### Postgres `BIGSERIAL`

Unique, simple, ordered. But generating one requires a round trip to a single database. That
database becomes a coordination point and a write bottleneck — and the scheme cannot survive
sharding at all, because two shards would independently issue `1, 2, 3`.

### UUID v4

Unique with zero coordination, which solves the first problem completely. But it is
**random**, and randomness costs three things:

- **No time ordering.** Sorting a timeline by id is meaningless, so you need a timestamp
  column and a secondary index on it — and you must fetch the tweets before you can sort
  them, which defeats [[timelines-as-id-lists]].
- **B-tree fragmentation.** Sequential inserts fill index pages densely. Random inserts
  scatter across pages, causing splits and write amplification.
- **16 bytes.** Double the storage in every index, every foreign key, and every timeline
  entry in Redis.

## Snowflake

Twitter built this for exactly this problem. 64 bits:

```
 1 bit    41 bits              10 bits        12 bits
┌──────┬───────────────────┬──────────────┬──────────────┐
│unused│ ms since epoch    │ machine id   │ sequence     │
└──────┴───────────────────┴──────────────┴──────────────┘
         ~69 years           1,024 nodes    4,096 per ms per node
```

- **41 bits of milliseconds** — ~69 years from a chosen epoch
- **10 bits of machine id** — 1,024 concurrent generators
- **12 bits of sequence** — 4,096 ids per millisecond per node

Total: ~4.2 million ids per second across the fleet, each generated locally in nanoseconds.

The sign bit stays unused so the value is always positive in languages with signed 64-bit
integers.

## What it buys

**1. Sorting by id is sorting by time.** The timestamp occupies the *high* bits, so numeric
order is chronological order. The timeline merge-sort becomes a plain integer comparison —
no timestamps, no index, no hydration before sorting. This is the property the whole read
path leans on.

**2. Zero coordination.** No network call, no lock, no sequence server.

**3. Cursor pagination for free.**

```sql
WHERE id < :cursor ORDER BY id DESC LIMIT 50
```

No `OFFSET`, and therefore none of `OFFSET`'s bug where rows are skipped or repeated because
new content arrived while the user was scrolling.

**4. Dense B-tree inserts**, because ids increase.

**5. 8 bytes.** A native `BIGINT`; a Redis integer-encoded list entry. This is precisely why
a 400-entry timeline costs 3.2 KB instead of 6.4 KB.

**6. The shard key is inside the id.** Sharding later is a routing change, not a migration.

## What it costs

- **Machine ids must be unique and allocated.** Two nodes sharing an id silently produce
  collisions. Kubernetes StatefulSet ordinals solve this cleanly; before that, a fixed id
  per compose service.
- **Clock skew breaks the guarantee.** If NTP moves the clock backwards, the generator can
  reissue ids it already used. The generator must detect this and refuse to issue — failing
  loudly beats producing duplicates quietly.
- **Ids leak information.** Creation time is readable, and two ids reveal how many were
  issued between them. Fine for public tweets; think twice for anything private.
- **JavaScript precision.** `Number.MAX_SAFE_INTEGER` is 2^53−1. A 64-bit id parsed as a
  JSON number is silently corrupted, so ids are serialised as **strings** everywhere.

## UUID v7, honestly

UUID v7 is time-ordered and standardised, and it solves the ordering problem too. It is a
genuinely good alternative and the right default for most new systems.

Snowflake wins here on 64 bits vs 128: across 3M materialised timelines × 400 entries, that
is roughly 10 GB of Redis. And Snowflake is what Twitter actually built — which counts, in a
project whose purpose is understanding Twitter.

## In this repository

- Decision: [ADR 0005](../adr/0005-snowflake-ids.md)
- Layout: [`03-data-model.md`](../03-data-model.md#identifiers)
- Implemented in Phase 3, in both Go and TypeScript, with cross-language tests

## Related

[[timelines-as-id-lists]] · [[hybrid-fanout]] · [[cqrs]]
