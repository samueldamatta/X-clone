# ADR 0003 — Hybrid fan-out for the home timeline

**Status:** Accepted · 2026-08-20

## Context

The home timeline is the product. It is also the only genuinely hard problem here:

> You follow 500 accounts. Show the 50 most recent tweets among them, in time order, in
> under 200 ms, while a million other people ask the same thing.

At Tier 2 that is ~350 timeline reads/s average and ~1,700/s at peak
([`02-capacity-estimation.md`](../02-capacity-estimation.md)), against ~6 tweet writes/s.
**The read:write ratio is roughly 60:1** — and at Twitter's scale closer to 1000:1. Any
design that makes reads cheaper at the expense of writes is trading in the right direction.

## Decision

Fan out on write for authors **under 10,000 followers**; skip fan-out entirely for authors
above it and merge their tweets in at read time.

A home timeline read becomes: `LRANGE user:{id}:home 0 49`, plus one `LRANGE` per followed
celebrity, merge-sorted by Snowflake ID, then hydrated with a single batched `MGET`.

## Consequences

**Gained**

- Reads are a small number of `LRANGE`s against memory — the path that runs 60× more often
  is the path that got optimised
- Write cost is bounded. No single tweet can trigger 40 million Redis writes, so no single
  account can stall everyone else's timeline
- Read-side merge stays small because users follow few celebrities

**Paid**

- **Two code paths** for what is conceptually one operation, each with its own bugs
- A **threshold-crossing problem**: when an account passes 10,000 followers, tweets already
  fanned out and tweets not yet fanned out coexist. Requires an explicit backfill job
- Timelines are eventually consistent — a tweet exists before it is in any timeline (N3)
- Fan-out consumers must be idempotent, or redelivery duplicates tweets in timelines

**Mitigated by**

- Denormalising `authorFollowerCount` onto the `tweet.created` event, so the worker decides
  the branch without an extra call to Graph on the hottest path
- Storing `is_celebrity` on `follow_counts` rather than computing it per tweet
- A dedupe key per `eventId` guarding every `LPUSH`

## Alternatives considered

**Pure fan-out on read.** Trivial writes, no consistency lag, no threshold problem.
Rejected because read cost scales with following count, so the most engaged users get the
worst latency — precisely inverted incentives — and 500 partition scans per request cannot
meet a 200 ms p99 at 1,700 RPS.

**Pure fan-out on write.** The simplest fast-read design, one code path. Rejected on the
celebrity problem: 40M Redis writes for one tweet saturates the worker pool and delays
every other user's fan-out. The failure is not gradual; it is a cliff.

**Threshold other than 10,000.** Somewhat arbitrary and deliberately tunable. Low enough
that few accounts qualify, high enough that a qualifying account's fan-out would genuinely
hurt. Phase 10 measures whether it is right.

## See also

- [`concepts/hybrid-fanout.md`](../concepts/hybrid-fanout.md) — the full explanation
- [`diagrams/02-hybrid-fanout-light.svg`](../diagrams/)
- [ADR 0005](0005-snowflake-ids.md) — why the merge-sort is free
