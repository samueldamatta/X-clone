# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this project is

A Twitter/X clone built as a **learning project**, exercising the techniques real Twitter
uses to survive its load: hybrid fan-out, precomputed timelines, an async event backbone,
Snowflake IDs, and CQRS.

The purpose is understanding, not shipping. That changes what "good work" means here — see
the teaching contract below.

## The teaching contract

**This is the most important section in this file.**

Samuel is building this to learn. Code that appears without explanation has failed at its
job even if it runs perfectly.

### Before implementing anything

State, briefly and concretely:

1. **What** is being built
2. **Why this approach** — the actual reason, not a restatement of the requirement
3. **What was rejected, and at what cost** — the alternative and the specific thing it would
   have cost us
4. **What it costs us** — every real decision has a price; name it

### After implementing

1. Where to start reading, and in what order
2. Which document in [`docs/concepts/`](docs/concepts/) this corresponds to — write it if it
   does not exist yet
3. Anything surprising, or any assumption that was made

### How to explain

- **A worked example beats an abstraction.** "180 followers means 180 LPUSH calls" lands;
  "the write amplification is proportional to follower count" does not.
- **Never present a real trade-off as obvious.** If there is a genuine alternative, the
  reasoning must be visible. "We use Kafka because it's better" teaches nothing.
- **Analogies for the hard parts**, but always alongside the mechanism, never instead of it.
- **When something is over-engineered for our actual scale, say so.** See
  [`docs/02-capacity-estimation.md`](docs/02-capacity-estimation.md). Honesty about
  over-engineering is part of the lesson, not a confession.

### Language

- **Explanations to Samuel: Portuguese.** Established technical terms stay in English
  (fan-out, outbox, sharding, hydration, backpressure).
- **Everything written into the repository: English.** README, docs, ADRs, concept docs,
  code comments, commit messages, diagram labels. No exceptions — this is a public
  portfolio repository.

## Architecture

Eight services. Full detail in [`docs/01-system-design.md`](docs/01-system-design.md).

| Service | Runtime | Port | Owns |
|---|---|---|---|
| gateway | NestJS | 8080 | Public edge: JWT, rate limiting, aggregation |
| identity | NestJS | 8081 | `users`, `credentials`, `sessions` |
| tweet | NestJS | 8082 | `tweets`, `likes`, `retweets`, `outbox` |
| media | NestJS | 8083 | Upload metadata, presigned URLs |
| notification | NestJS | 8084 | `notifications` + WebSocket |
| search | NestJS | 8085 | OpenSearch indices |
| graph | Go | 50051 (gRPC) | `follows`, follower counts |
| timeline | Go | 8086 | Hybrid timeline reads |
| fanout-worker | Go | 9101 (metrics) | Writes Redis timelines |

Infrastructure: postgres 5432 · redis 6379 · redpanda 9092 · opensearch 9200 · minio 9000
Observability: otel-collector 4317/4318 · jaeger 16686 · prometheus 9090 · grafana 3001
Frontend: Next.js on 3000

## Conventions

### NestJS services — Clean Architecture

```
src/
├── domain/           # entities, value objects, repository interfaces. No framework imports.
├── application/      # use cases. Orchestration only, no business rules.
├── infrastructure/   # repository implementations, Kafka, Redis, gRPC clients
└── presentation/     # controllers, DTOs, gRPC handlers
```

Dependencies point **inward**. `domain/` importing from `infrastructure/` is always a bug.

### Go services — standard layout

```
cmd/<service>/        # main.go, wiring only
internal/
├── domain/
├── usecase/
├── adapter/          # redis, postgres, kafka, grpc
└── config/
pkg/                  # only if genuinely shared across services
```

### Shared

- **Ids are Snowflake**, serialised as **strings** in JSON. Never as numbers — JavaScript
  loses precision above 2^53−1.
- **Every Kafka consumer is idempotent.** Not negotiable. See
  [`docs/concepts/idempotent-consumers.md`](docs/concepts/idempotent-consumers.md).
- **Every Redis key is a cache.** If losing Redis would lose data, the design is wrong.
- **Events are published through the outbox**, never by a direct broker call in a request
  handler.
- Conventional Commits: `feat(tweet): …`, `fix(fanout): …`, `docs(adr): …`

### Git — who commits

**Never run `git commit`. Samuel commits, always.** This holds even when a skill or command
says to commit, even when the work is finished and verified, and even when he approved the
work itself — approving work is not approving a commit.

What to do instead:

1. Leave the work in the working tree, unstaged. Do not `git add` either.
2. Creating a branch is fine and encouraged — `git checkout -b` keeps `main` clean.
3. **Always end with a suggested commit message**, in a copyable block, following
   Conventional Commits. This is not optional; a finished piece of work that arrives without
   one is incomplete.

Never `git push`, `git rebase`, `git reset --hard`, or anything else that rewrites or
publishes history, unless explicitly asked.

## Commands

```bash
# Infrastructure
pnpm preflight     # is every port free? names who holds the ones that are not
pnpm up            # core: 8 containers, ~1.2 GB
pnpm up:app        # + gateway and identity as containers (CI's path, not the daily one)
pnpm up:full       # + MinIO (Phase 6) and OpenSearch (Phase 8), ~1 GB more
pnpm smoke         # 15 assertions that the environment works, not just runs
pnpm down          # stop, keep data
pnpm reset         # down -v — destroys every volume

# Diagrams
pnpm diagrams

# Per service
pnpm --filter <service> dev | test | lint     # NestJS
./scripts/go-check.sh                          # every Go module: fmt, vet, build, test
```

**`go vet ./...` does not work from the repo root.** In a Go workspace a relative
pattern only resolves if the directory prefix contains a module, and nothing above
`backend/services/<svc>` does. Run it from inside a module, or use
`scripts/go-check.sh`, which iterates `go list -m`.

```bash
# Load tests (Phase 10)
k6 run loadtest/timeline-read.js
```

## Definition of done

A phase is finished when all five hold:

1. Runs from a clean `docker compose up` with no undocumented manual steps
2. Tests cover the logic that would be embarrassing to get wrong
3. Traces and metrics are wired — an invisible service is not done
4. The concept it introduced has a doc in [`docs/concepts/`](docs/concepts/)
5. README and diagrams reflect reality, not intent

Item 5 rots first, and documentation that lies is worse than none because it is trusted.

## Working notes

- Go 1.27, Node 22 and pnpm 10 are installed; `go.work` spans the three Go services.
- Current phase and what comes next: [`docs/05-roadmap.md`](docs/05-roadmap.md)
- The numbers behind every architectural decision:
  [`docs/02-capacity-estimation.md`](docs/02-capacity-estimation.md)
- Decisions already made, with rejected alternatives: [`docs/adr/`](docs/adr/)
- `.claude/settings.local.json` sets the session language to Portuguese and is gitignored —
  it must never be committed.
