# Timelines as ID lists in Redis

Two decisions hide inside one sentence: *why Redis*, and *why only the ids*.

## Why Redis and not Postgres

A timeline read is `LRANGE user:{id}:home 0 49` — fifty contiguous entries in memory,
roughly 0.1–0.3 ms.

The equivalent in Postgres is an index scan plus heap fetches from disk plus a merge:
10–100 ms depending on cache state. At 1,700 reads/s that difference stops being an
optimisation and becomes the difference between working and not working.

Redis is also the right *shape*: a capped, ordered list of ids is exactly the `LPUSH` +
`LTRIM` primitive, and Redis does it atomically.

## Why only the ids

The list holds `[1847362819374, 1847362819211, ...]` — 8-byte integers. Not the text, not
the author, not the counters.

### Memory

```
800 ids × 8 bytes                 =   6.4 KB per user
800 full tweets × ~1 KB           = 800   KB per user      — 125× more

3M materialised timelines:
  ids only                        =  ~20 GB  (with Redis overhead)
  full bodies                     =  ~2.4 TB
```

### Duplication

A tweet from a 200-follower account would exist as 200 copies in memory. With ids, the body
exists **once**, in a separate `tweet:{id}` cache.

### Mutability — the decisive one

Like and retweet counts change constantly. If the tweet body were copied into 200
timelines, a single like would mean 200 stale copies. There is no good fix for that: you
either accept wrong numbers or you write 200 updates per like.

With ids, the body is fetched fresh at read time, so counters are always as current as the
tweet cache.

> **Analogy.** The timeline is a library index — catalogue numbers, not photocopies of the
> books.

## Hydration

After `LRANGE` you hold 50 ids and no content. Turning ids into objects is **hydration**:

```
MGET tweet:1847362819374 tweet:1847362819211 ...   # one batched round trip
```

One `MGET`, not fifty `GET`s. The hit ratio is high because recent tweets are read by many
people at once — the same property that makes the timeline hot makes the cache effective.

Misses fall through to the Tweet service, which reads Postgres and re-populates the cache
(cache-aside).

## What it costs

- **An extra round trip** on every read — first the ids, then the bodies. Worth it, but not
  free.
- **A two-level miss.** If both the timeline and the tweet cache are cold, the request
  falls all the way to Postgres.
- **Discipline.** The tempting shortcut is always to let a cached value become the only
  copy of something. Every Redis key in this project must remain rebuildable from Postgres,
  and that has to be defended in review.

## In this repository

- Key schema: [`03-data-model.md`](../03-data-model.md#redis-key-schema)
- Read path: [`01-system-design.md`](../01-system-design.md#the-read-path)

## Related

[[hybrid-fanout]] · [[cqrs]] · [[snowflake-ids]]
