# ADR 0001 — Hybrid service split instead of a modular monolith

**Status:** Accepted · 2026-08-20

## Context

The stated goal is to learn distributed systems. The stated non-goal is to ship a product
to users.

[`02-capacity-estimation.md`](../02-capacity-estimation.md) is unambiguous about the
engineering reality: at the realistic target of 1M DAU this workload is ~6 tweet writes/s
and ~350 timeline reads/s. A single well-tuned monolith with one Postgres and one Redis
would serve it with 100–500× headroom. Companies have run this load on Rails.

So the honest framing of the decision is not "which architecture is correct" — the modular
monolith is correct on the merits. It is "what do we give up, and gain, by choosing the one
that teaches more".

## Decision

Eight bounded services — Gateway, Identity, Graph, Tweet, Timeline API, Fanout Worker,
Media, Notification, Search — cut along the seams where reasons to change genuinely
diverge.

**Not** 15 nano-services. Each service here owns a coherent slice of domain and has a
defensible reason to be deployable on its own, documented in
[`01-system-design.md`](../01-system-design.md#service-decomposition).

## Consequences

**Gained**

- Real exposure to service boundaries, async messaging, eventual consistency, partial
  failure, and distributed tracing — none of which can be simulated inside one process
- Independent scaling where it genuinely differs: Fanout Worker scales on Kafka lag,
  Timeline API on request rate
- Failure isolation satisfying N4: Media, Search and Notifications can all be down while
  tweeting still works

**Paid**

- Substantially more infrastructure before the first tweet renders
- Every cross-service read is a network call that can fail, time out, or arrive twice
- No cross-service transactions; consistency becomes the application's problem
- Debugging requires distributed tracing to be in place *first*, not later
- More total code, most of it plumbing

**Mitigated by**

- Requiring [`02-capacity-estimation.md`](../02-capacity-estimation.md) to state the
  over-engineering explicitly, including the trigger table showing when each component
  would actually earn its place
- Keeping the service count low enough that one person can hold the system in their head

## Alternatives considered

**Modular monolith, extract later.** The correct answer for a real product, and the one
most senior engineers would give. Rejected only because deferring service extraction defers
the entire learning goal — and in practice "extract later" usually means "never", so the
lesson would likely never arrive.

**Full microservices from day one** — 15+ services, service mesh, saga orchestration.
Rejected as mostly infrastructure yak-shaving. The marginal lesson from service #12 is near
zero; the marginal cost is not.

## See also

- [ADR 0002](0002-go-on-the-hot-path.md) — which services get which runtime
- [`02-capacity-estimation.md`](../02-capacity-estimation.md) — the numbers that indict this decision
