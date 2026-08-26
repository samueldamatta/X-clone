# Hybrid fan-out

## The problem

You follow 500 accounts. Open the app, and you need the 50 most recent tweets among those
500, in time order, in under 200 ms — while a million other people ask the same thing.

The difficulty is that the answer is different for every user, and it changes every second.

## Option A — fan-out on read (pull)

Compute it at request time:

```sql
SELECT * FROM tweets
 WHERE author_id IN (:five_hundred_ids)
   AND deleted_at IS NULL
 ORDER BY id DESC
 LIMIT 50;
```

**Cheap writes:** posting a tweet is one INSERT.

**Expensive reads:** every request touches 500 authors' data and merge-sorts the result.
At ~350 requests/s that is 175,000 author lookups per second.

**Where it breaks:** the cost scales with *how many accounts you follow*. Someone following
5,000 accounts gets a request ten times more expensive than someone following 500 — so your
most engaged users receive your worst latency. That incentive is exactly backwards.

> **Analogy.** Every time you want to read the news, you visit 500 people's houses and ask
> each what they wrote today.

## Option B — fan-out on write (push)

Precompute it. When someone tweets, push the tweet id into a ready-made list for each of
their followers:

```
LPUSH user:{follower_id}:home  {tweet_id}     # once per follower
LTRIM user:{follower_id}:home  0 399
```

**Cheap reads:** `LRANGE user:{id}:home 0 49`. One operation, ~0.2 ms, and the cost is the
same whether you follow 5 accounts or 5,000.

**Expensive writes:** one tweet from a 200-follower account is 200 Redis writes.

**Where it breaks:** an account with 40 million followers. One tweet becomes 40 million
writes. The worker pool saturates, the consumer lag climbs into minutes, and *every other
user's* timeline goes stale behind it. This is the **celebrity problem**, and the failure is
a cliff, not a slope.

> **Analogy.** A courier drops a copy of what you wrote into every follower's mailbox. When
> you open yours, everything is already there — unless the sender has 40 million mailboxes
> to fill.

## Option C — hybrid (what this project builds)

Notice that the two failures have *opposite* shapes, and split on that:

| Author | Followers | At write time | At read time |
|---|---|---|---|
| Ordinary (~99.9% of accounts) | ≤ 10,000 | Push to every follower's list | Already there |
| Celebrity | > 10,000 | **Skip fan-out.** Write only to `author:{id}:tweets` | Merge their list in |

A home timeline read becomes:

```
1. LRANGE user:{id}:home 0 49                  → precomputed portion
2. LRANGE author:{c}:tweets 0 49  per celebrity → the 5–20 you follow
3. merge-sort by snowflake id, take newest 50
4. MGET tweet:{id} × 50                         → hydrate bodies
```

### Why it balances

Two asymmetries cancel out:

- You follow **thousands** of ordinary accounts but only a **handful** of celebrities — so
  the read-side merge stays small.
- Celebrities are **rare** — so skipping their fan-out removes most of the write cost.

Neither fact alone would be enough. Together they make the hybrid strictly better than
either pure strategy at this scale.

## What it costs

Nothing here is free, and the costs are the part usually left out:

- **Two code paths** for one conceptual operation. Two sets of bugs, two things to keep
  consistent, and the "obvious" refactor that merges them will break one of them.
- **The threshold-crossing problem.** When an account passes 10,000 followers, tweets
  already fanned out and tweets never fanned out coexist. Without an explicit backfill,
  some followers see duplicates and others see gaps. This is the bug you will actually hit.
- **Eventual consistency.** A tweet exists before it appears in anyone's timeline.
- **Idempotency becomes mandatory.** Kafka redelivery without a dedupe guard puts the same
  tweet in a timeline twice.

## In this repository

- Decision and rejected alternatives: [ADR 0003](../adr/0003-hybrid-fanout.md)
- Diagram: [`02-hybrid-fanout`](../diagrams/)
- Built in Phase 4 — [`05-roadmap.md`](../05-roadmap.md)

## Related

[[timelines-as-id-lists]] · [[snowflake-ids]] · [[idempotent-consumers]] ·
[[async-event-backbone]]
