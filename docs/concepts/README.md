# Concepts

One document per idea, written the same way every time:

> **the problem → the naive options and exactly where each breaks → the choice → what it costs**

That last section is the one that matters. Anyone can list patterns; the useful skill is
knowing what each one takes from you, so you can tell when it is not worth paying.

These are written to be read in order the first time, and dug into individually later.

## The five that hold up the timeline

| Concept | The question it answers |
|---|---|
| [Hybrid fan-out](hybrid-fanout.md) | How do you build a home timeline that is fast for everyone, including the follower of a celebrity? |
| [Timelines as ID lists](timelines-as-id-lists.md) | Why store ids in Redis instead of tweets, or instead of querying Postgres? |
| [Asynchronous event backbone](async-event-backbone.md) | Why does posting a tweet return before anything has actually happened? |
| [Snowflake IDs](snowflake-ids.md) | Why not just use a UUID? |
| [CQRS](cqrs.md) | Why is the same tweet stored in four different shapes? |

## The ground it all runs on

| Concept | The question it answers |
|---|---|
| [The local environment](local-environment.md) | How do nine services and six data stores run on one laptop, the same way in CI? |
| [Internal gRPC](internal-grpc.md) | Why do the services speak protobuf to each other while the world outside gets REST? |
| [Access and refresh tokens](access-and-refresh-tokens.md) | Why two tokens instead of one, and why does a failed login refuse to say what was wrong? |

## The two that make the above survivable

| Concept | The question it answers |
|---|---|
| [Transactional outbox](transactional-outbox.md) | What if the database commits but the event never publishes? |
| [Idempotent consumers](idempotent-consumers.md) | What happens when the same event arrives twice? |

## Still to be written

Added as each phase reaches them:

- Token-bucket rate limiting (Phase 2)
- Cache-aside and hydration (Phase 4)
- Consumer lag as backpressure (Phase 4)
- Circuit breakers and bulkheads (Phase 9)
- Sliding-window counters for trending (Phase 8)
