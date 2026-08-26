# ADR 0002 — Go on the hot path, NestJS everywhere else

**Status:** Accepted · 2026-08-20

## Context

With services chosen ([ADR 0001](0001-hybrid-services-over-monolith.md)), each needs a
runtime. The workloads are not alike:

- **Request-shaped work** — auth, CRUD, validation, orchestration. Bounded by IO and by how
  fast a developer can express business rules.
- **Throughput-shaped work** — fan-out issuing thousands of Redis writes per second;
  timeline merge-sort and hydration on the p99-critical read path; the follower-graph
  lookups fan-out performs on every event.

Treating those identically optimises for neither.

## Decision

| Runtime | Services | Because |
|---|---|---|
| **Go** | Graph, Timeline API, Fanout Worker | Goroutines make thousands of concurrent Redis pipelines cheap; predictable latency without GC pauses dominating p99; a compiled static binary in a small container |
| **NestJS (TypeScript)** | Gateway, Identity, Tweet, Media, Notification, Search | DI and module structure fit Clean Architecture; shares types and vocabulary with the Next.js frontend; faster to express domain rules |

Protobuf (`backend/libs/proto/`) is the contract between them, so neither language's types
leak across the boundary.

## Consequences

**Gained**

- The hot path runs on a runtime built for concurrent IO
- Direct experience of *why* teams reach for Go at these seams — not as folklore, but from
  having felt the difference
- Protobuf schemas become genuinely load-bearing rather than ceremonial, because two
  languages must agree

**Paid**

- Two toolchains, two dependency managers, two test idioms, two CI paths
- Shared logic (Snowflake generation, OTel setup, Kafka client config) implemented twice
- Context-switching cost for a single developer
- Go must be installed before Phase 3 (`brew install go`)

**Mitigated by**

- Keeping duplicated infrastructure code small and its behaviour pinned by cross-language
  tests — a Snowflake ID generated in Go and one generated in TypeScript must be mutually
  decodable

## Alternatives considered

**TypeScript everywhere.** One language, one toolchain, fastest to build. Rejected because
it removes the very comparison that makes the hot-path split instructive — and Node's
single-threaded event loop is a poor fit for pipelined fan-out at 5,800 writes/s.

**Go everywhere.** Consistent and fast. Rejected because the CRUD services gain little from
it, the frontend is TypeScript regardless, and NestJS conventions transfer directly to work
Samuel already does.

**Java + Spring Boot.** Closest to what Twitter actually ran on the JVM. Rejected on local
footprint and iteration speed for a solo project.

## See also

- [`01-system-design.md`](../01-system-design.md#service-decomposition)
- [ADR 0003](0003-hybrid-fanout.md) — the workload that justifies Go
