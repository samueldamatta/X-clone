# ADR 0004 — Kafka as the event backbone

**Status:** Accepted · 2026-08-20

## Context

Posting a tweet should cause seven things: persist it, fan out to followers, index it for
search, extract hashtags for trends, notify mentioned users, run moderation, and update
analytics.

Doing those synchronously makes the user's request wait for all seven — p99 becomes the
*sum* of every downstream system. Worse, it couples availability: if the search index is
down, nobody can tweet. That directly violates N4.

## Decision

The Tweet service persists and returns. Everything else consumes events from Kafka
(Redpanda locally — same protocol, one binary, no ZooKeeper).

Topics: `tweet.created`, `tweet.deleted`, `tweet.liked`, `user.followed`,
`user.registered`, each with a dead-letter topic. Partition keys chosen for **ordering**,
not balance — `tweet.created` is keyed by `authorId` so an author's create and delete
cannot arrive out of order.

Events are published via a [transactional outbox](../concepts/transactional-outbox.md),
never by a direct broker call inside request handling.

## Consequences

**Gained**

- Write p99 is persistence only — roughly 20 ms instead of the sum of seven systems
- Secondary features fail in isolation (N4)
- **A replayable log.** A consumer that was down for three hours resumes from its offset. A
  corrupted OpenSearch index is fixed by replaying from offset zero. Derived state stops
  being precious
- New consumers attach to existing topics without touching any producer

**Paid**

- **Eventual consistency**, everywhere and permanently. The single largest cost, and it
  reaches all the way to the UI
- **At-least-once delivery.** Every consumer must be idempotent. This is not optional and
  it is not obvious to someone who has not been burned by it
- The dual-write problem, requiring the outbox and its publisher
- One more system to operate, monitor (consumer lag), and reason about
- Local development needs a broker running

**Mitigated by**

- Redpanda locally: Kafka-compatible, a fraction of the memory, no ZooKeeper
- `eventId` on every event plus a short-lived dedupe key in every consumer
- Consumer lag as a first-class Grafana metric from Phase 9

## Alternatives considered

**Direct synchronous calls.** Simplest, strongly consistent. Rejected on N4 and on write
latency.

**RabbitMQ / SQS.** Lighter and adequate for job dispatch. Rejected because they are
queues, not logs: once consumed, a message is gone. No replay, no independent offsets per
consumer, no rebuilding a read model from history — and replay is the property that makes
derived stores disposable.

**In-process queue (BullMQ).** Genuinely sufficient at Tier 2, and the trigger table says
so. Rejected here because the multi-consumer, replayable-log semantics are a core part of
what this project exists to teach.

## See also

- [`concepts/async-event-backbone.md`](../concepts/async-event-backbone.md)
- [`concepts/transactional-outbox.md`](../concepts/transactional-outbox.md)
- [`concepts/idempotent-consumers.md`](../concepts/idempotent-consumers.md)
