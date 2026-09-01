# The local environment

> The question it answers: **how do nine services and six pieces of infrastructure run on
> one laptop, in a way that is the same laptop-to-laptop and the same as CI?**

## The problem

This system is nine services, five data stores and four observability containers. A
developer needs all of it before they can meaningfully change any of it — the Fanout Worker
is untestable without Kafka, Redis and the Graph service, and the Timeline API is
untestable without the timelines the worker writes.

So the environment is not a convenience. It is the thing that decides whether the project
is workable at all.

## The naive options, and exactly where each breaks

**Install everything natively.** `brew install postgresql redis opensearch`, run them as
services. Fastest possible startup, no virtualisation overhead, and everything is on
localhost.

It breaks on version drift and on collisions. Your Postgres 16 and a teammate's 15 disagree
about something subtle six weeks in. Worse, the machine already has services: writing this
document required stopping a Homebrew Redis on `:6379` that belonged to nothing in this
project and that no `docker compose down` would have touched. Native installs also have no
teardown — "reset my database" becomes a manual procedure, and manual procedures rot.

**One VM for everything.** Vagrant, or a Lima VM, running all of it inside. Isolation is
total and version drift is gone.

It breaks on the edit-run loop. Code lives on the host, runs in the VM, and the filesystem
between them is either slow or eventually inconsistent. It also forces the whole
environment to be one unit: you cannot restart just Redis to test a cold-cache path.

**kind / k3d from day one.** Run the real orchestrator locally, so local matches production.

It breaks on the cost of the loop. Every code change becomes build image → load into
cluster → roll deployment, which turns a two-second feedback cycle into forty. It also
front-loads Kubernetes onto Phase 1, when the thing being learned is Postgres and Kafka.
This project does reach Kubernetes — in Phase 11, when there is something worth
orchestrating.

## The choice

**Docker Compose, with profiles for what is not yet consumed.**

Containers give version pinning and a real teardown (`down -v`). Compose keeps each piece
independently restartable, so `docker compose restart redis` is a genuine cold-cache drill.
And the same file runs in CI, which is what stops "works on my machine" from being a class
of bug here.

Profiles split it further. MinIO is not consumed until Phase 6 and OpenSearch not until
Phase 8, and OpenSearch alone holds **~1 GB**:

| Set | Containers | Resident memory |
|---|---|---|
| core (default) | 8 | ~1.2 GB |
| `--profile media` | +1 (MinIO) | +76 MB |
| `--profile search` | +1 (OpenSearch) | +1.0 GB |

Measured with `docker stats` on an M-series Mac. Redpanda is the surprise in the core set at
~960 MB — more than Postgres, Redis, Prometheus, Grafana and Jaeger combined.

## What it costs

**The definition of done gets a footnote.** "Runs from a clean `docker compose up`" is now
true for the core set and needs a flag for the rest. Footnotes are where documentation
begins to lie, so the profile lives in a named script (`pnpm up:full`) rather than in
someone's memory.

**Compose is not production.** No pod scheduling, no rolling updates, no resource limits
worth the name. Anything learned here about *operating* the system has to be re-learned in
Phase 11. What transfers is the topology and the wiring, not the orchestration.

**Ports are global state.** One `:5432` per machine. The port map is fixed in
[`../diagrams/03-local-environment-light.svg`](../diagrams/) and enforced by
`scripts/preflight.sh`, which reports who holds a taken port and how to release it — because
the failure mode otherwise is a container that exits with `bind: address already in use`
buried in a log nobody scrolled to.

## Two things that are not obvious

### A Kafka client connects twice, so one address is not enough

A Kafka client bootstraps against the address you give it, then receives the broker's
**advertised** address and reconnects to *that* for every subsequent operation. If the
broker advertises `redpanda:9092`, a client on the host resolves nothing. If it advertises
`localhost:9092`, a client inside the network reaches itself.

The failure is memorable because it is so asymmetric: connection succeeds, metadata
succeeds, and every produce times out.

The fix is two listeners with two advertised addresses:

```
--kafka-addr=internal://0.0.0.0:9092,external://0.0.0.0:19092
--advertise-kafka-addr=internal://redpanda:9092,external://localhost:9092
```

Then `9092:19092` publishes the external listener on the port the diagram promises. The
same problem, with the same shape, exists in real Kafka.

### A healthcheck is a liveness claim, not a readiness one

`pg_isready` returns true the moment Postgres accepts connections — which is before
`/docker-entrypoint-initdb.d` has finished creating schemas. `depends_on:
condition: service_healthy` therefore does *not* guarantee the schemas exist.

This project gets away with it because nothing depends on Postgres in Phase 1. From Phase 2,
migrations run as an explicit step rather than trusting startup ordering. Ordering
guarantees that come from timing are the ones that fail in CI and nowhere else.

## Why service boundaries are enforced by the database

[`../03-data-model.md`](../03-data-model.md) says the boundary is enforced *in the access
path, not the deployment topology*. Locally, one Postgres holds all five schemas — so with
a single `postgres` role, that sentence would be aspirational: nothing would stop the Tweet
service from reading `identity.users`, and the join that saves twenty minutes at 11pm is
exactly how a distributed monolith gets built.

Five roles, each granted `USAGE, CREATE` on one schema and nothing elsewhere, make the
database refuse. `scripts/smoke.sh` asserts it, so it is a test rather than an intention:

```
✓  tweet_svc is refused access to identity.* (boundary enforced)
```

The cost is five connection strings instead of one, and needing the superuser consciously
when debugging across schemas. Both are the point.

## See also

- [`../01-system-design.md`](../01-system-design.md) — what these containers become
- [`../03-data-model.md`](../03-data-model.md) — the schemas and the Redis key space
- [`../diagrams/03-local-environment-light.svg`](../diagrams/) — the port map, which is the
  source of truth for every port in `compose.yml`
