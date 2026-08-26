# Idempotent consumers

## The problem

Kafka guarantees **at-least-once** delivery. Not exactly-once. The same message will
eventually be delivered twice, because:

- A consumer processes a message, then crashes before committing its offset. On restart it
  reads the same message again.
- A consumer group rebalances mid-batch and a partition's uncommitted messages are
  reprocessed by a new owner.
- The [[transactional-outbox]] publisher publishes, then dies before marking the row.
- Any retry, anywhere.

None of these are exotic. They are Tuesday.

## What it looks like when you get it wrong

The Fanout Worker receives `tweet.created` twice:

```
LPUSH user:900:home 1847362819374
LPUSH user:900:home 1847362819374     # redelivery
```

The user now sees the same tweet twice in their timeline. Counter consumers are worse — a
redelivered `tweet.liked` increments `like_count` twice, and the number is now permanently
wrong with no way to notice.

The cruelty of this bug is that it never appears locally. It appears in production, under
load, during the rebalance that happened because a node was replaced.

## Idempotency: the definition worth internalising

> An operation is idempotent if performing it **N times** has the same effect as performing
> it **once**.

`SET x = 5` is idempotent. `x = x + 1` is not. Most of the useful work in a system is the
second kind, so idempotency has to be engineered rather than assumed.

## Three ways to get it

### 1. Dedupe key — the general tool

Every event carries a unique `eventId`. Before acting, claim it:

```ts
// SET NX = "set if not exists". Atomic: only the first caller gets true.
const first = await redis.set(`dedupe:fanout:${eventId}`, '1', {
  NX: true,
  EX: 86_400,        // long enough to outlive any realistic redelivery window
});
if (!first) return;  // already processed — drop it
await fanOut(event);
```

The window matters. Too short and a late redelivery slips through; too long and you store
dedupe keys for events nobody will ever resend.

There is still a gap between claiming the key and finishing the work — if the process dies
in between, the event is dropped rather than reprocessed. Closing that fully needs the work
and the marker to be atomic, which is the next option.

### 2. Naturally idempotent operations — the best tool

Sometimes you can restructure the write so duplicates cannot hurt:

| Instead of | Use |
|---|---|
| `LPUSH` (appends every time) | `ZADD` with the tweet id as score — re-adding is a no-op |
| `like_count = like_count + 1` | `INSERT INTO likes … ON CONFLICT DO NOTHING`, then recount |
| "send notification" | Upsert by `(recipient, kind, actor, subject)` |

This is strictly better than a dedupe key because it needs no extra state and cannot drift.
Reach for it first, always.

### 3. Idempotency keys at the API edge

The same problem exists one layer up: a user double-taps "Tweet" on a flaky connection.
`POST /v1/tweets` accepts an `Idempotency-Key` header; a repeat within the window returns
the original response instead of creating a second tweet.

This is also why likes use `PUT`/`DELETE` rather than `POST` — the HTTP verb is idempotent
by definition.

## What it costs

- **Extra state.** Dedupe keys are memory, and they need a TTL policy someone has to
  choose deliberately.
- **A discipline, not a feature.** Every new consumer must be written this way. It cannot be
  added centrally afterwards, and code review is the only enforcement.
- **Not free of edge cases.** The claim-then-work gap above is real; the fix is either
  transactional (work and marker in one commit) or accepting at-least-once semantics with
  naturally idempotent operations.

## In this repository

- Every Kafka consumer from Phase 4 onward
- Dedupe key schema: [`03-data-model.md`](../03-data-model.md#redis-key-schema)
- Event contracts carry `eventId`: [`04-api-contracts.md`](../04-api-contracts.md#kafka-event-contracts)

## Related

[[async-event-backbone]] · [[transactional-outbox]] · [[hybrid-fanout]]
