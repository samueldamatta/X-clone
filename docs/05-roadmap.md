# Roadmap

Twelve phases. Each one ends with something that runs and something learned — never a phase
that only produces scaffolding.

The ordering follows one rule: **build the thing that teaches the most, as early as its
dependencies allow.** That is why the Fanout Worker (Phase 4) comes before the frontend,
even though a frontend would make the project look finished sooner. Fan-out is the reason
this project exists; a pretty timeline over a naive query would not be.

| # | Phase | Ships | Teaches |
|---|---|---|---|
| 0 | ~~Design & documentation~~ | Diagrams, ADRs, capacity model, this roadmap | Deciding boundaries while they are still cheap to move |
| 1 | **Infrastructure baseline** ← *here* | `docker compose up` brings up Postgres, Redis, Redpanda, MinIO, OpenSearch, Jaeger, Prometheus, Grafana; monorepo with pnpm workspaces + Go modules; CI | Running a distributed environment locally |
| 2 | Identity + Gateway | Register, log in, refresh rotation, rate limiting, first end-to-end request | JWT vs sessions, token rotation, token-bucket limiting |
| 3 | Tweet + Graph | Post and delete tweets; follow and unfollow; first gRPC call; first outbox row | Snowflake IDs, the outbox pattern, protobuf contracts |
| 4 | **Fanout Worker + Timeline API** | A working home timeline with the hybrid split | Kafka consumers, idempotency, hybrid fan-out, consumer lag — **the centrepiece** |
| 5 | Frontend | Next.js: timeline, compose, profile, follow | Infinite scroll, optimistic updates, designing around eventual consistency |
| 6 | Media | Presigned uploads, async variant processing, CDN URLs | Keeping bytes off the API path; failure isolation |
| 7 | Notifications | Kafka consumer, WebSocket gateway, real-time delivery | Long-lived connections, fan-out to sockets, reconnection |
| 8 | Search + trends | OpenSearch indexing, tweet and user search, trending topics | Derived read models, index rebuilds, sliding-window counters |
| 9 | Observability | OpenTelemetry traces across every hop, Grafana dashboards, SLOs | Reading a distributed trace; choosing what to measure |
| 10 | **Load testing** | k6 suite, published results | Turning "it scales" into a number with hardware attached |
| 11 | Kubernetes | kind/k3d manifests, HPA, resilience and chaos testing | Orchestration, autoscaling signals, partial failure |

## Definition of done

A phase is not finished when the code runs. It is finished when all five hold:

1. It runs from a clean `docker compose up` with no undocumented manual steps
2. Tests cover the logic that would be embarrassing to get wrong
3. Traces and metrics are wired — a new service that is invisible is not done
4. The concept it introduced has a doc in [`concepts/`](concepts/)
5. `README.md` and the diagrams reflect reality, not intent

Item 5 is the one that rots first. Documentation that lies is worse than none, because it
is trusted.

## Phase 10 in detail

The phase that decides whether the README's claims survive contact with a load generator.

**Target** (derived from Tier 2 in [`02-capacity-estimation.md`](02-capacity-estimation.md)):
~1,700 RPS of timeline reads, ~30/s of writes, plus supporting traffic — **~3,000 RPS peak**.

**Pass bar**

| Metric | Threshold |
|---|---|
| `GET /timeline/home` p99 | < 200 ms |
| `POST /tweets` p99 | < 300 ms |
| Error rate | < 0.1% |
| Kafka consumer lag | returns to zero within 30 s of peak |

**Traffic mix**, modelled on real usage rather than a uniform blend: ~85% reads, ~5%
writes, ~10% engagement (likes, follows, profile views), with a hot-key distribution so the
cache hit ratio is realistic instead of flattering. A load test where every request hits a
different cold key measures the wrong system; so does one where they all hit the same warm
key.

**Published in the README:** the Grafana screenshot, the k6 summary, and the hardware it ran
on. A latency figure without its hardware is not a result.

## After Phase 11

Deliberately unscheduled, because they are worth doing only if the earlier phases held up:

- Sharding the tweet store, once the trigger table says so
- ScyllaDB or Cassandra as the tweet store, mirroring Twitter's Manhattan
- Multi-region with read-local, write-home routing
- Ranked timeline as an alternative read model, alongside the chronological one
- Cell-based architecture — partitioning users into independent stacks

## See also

- [`01-system-design.md`](01-system-design.md)
- [`02-capacity-estimation.md`](02-capacity-estimation.md) — where Phase 10's targets come from
