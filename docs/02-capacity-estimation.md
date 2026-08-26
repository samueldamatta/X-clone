# Capacity Estimation

> Every architectural decision in this repository is downstream of the numbers on this
> page. If you disagree with a decision, start by disagreeing with an assumption here —
> each figure is shown with the input that produced it, so the arithmetic is checkable
> and the inputs are arguable.

## Why this document exists first

"Built to handle Twitter-scale traffic" is a claim, and an unquantified claim is a
liability in a portfolio. The interesting engineering question is never *can this scale* —
almost anything scales with enough machines. It is **at what load does each component
stop being premature**, and what does the answer cost.

So this page carries three sizing tiers and a trigger table. The architecture we build and
diagram targets Tier 3. The deployment anyone would actually run is Tier 2. The gap
between those two facts is stated plainly rather than hidden.

## Shared assumptions

| Input | Value | Note |
|---|---|---|
| Tweets per active user per day | 0.5 | Most accounts read far more than they write |
| Timeline requests per active user per day | 30 | App opens plus infinite-scroll pages |
| Average followers per author | 200 | Median is far lower; the mean is dragged up by large accounts |
| Tweet record size | ~1 KB | 280 chars plus author, timestamps, counters, entities |
| Media attachment rate | 10% of tweets | At ~300 KB per processed image |
| Peak-to-average ratio | 5× | Evening peak plus event spikes |
| Timeline cache depth | 800 entries | ~16 pages of 50; beyond that, fall back to the database |

Seconds in a day: **86,400**. That single number does most of the work below.

## The three tiers

|  | **Tier 1 — 10k DAU** | **Tier 2 — 1M DAU** *(realistic target)* | **Tier 3 — 150M DAU** *(what we diagram)* |
|---|---|---|---|
| Tweet writes | 0.06/s | **6/s** avg · 30/s peak | 5,800/s avg · 15,000/s peak |
| Timeline reads | 3.5/s | **350/s** avg · 1,700/s peak | ~100,000/s avg · ~300,000/s peak |
| Total API peak | <50 RPS | **~3,000 RPS** | ~500,000 RPS |
| Fan-out writes | 12/s | **1,200/s** avg · 5,800/s peak | ~1,200,000/s |
| Tweet storage | 1.8 GB/yr | **180 GB/yr** | 180 TB/yr |
| Media storage | 55 GB/yr | **5.5 TB/yr** | 5.5 PB/yr |
| Redis timelines | ~200 MB | **~20 GB** | ~2.5 TB (cluster) |
| Shape | Monolith, one box | Monolith or 2–3 services, Redis timelines, in-process queue, read replica, CDN | Full 8-service design, Kafka, sharding, multi-region |
| Rough infra cost | ~$50/mo | ~$500–2,000/mo | nine figures/yr |

### Working: Tier 2, step by step

```
Tweet writes      1M DAU × 0.5 tweets/day        =    500,000 /day
                  500,000 / 86,400               =          5.8 /s  avg
                  × 5 peak factor                =         29   /s  peak

Timeline reads    1M DAU × 30 requests/day       = 30,000,000 /day
                  30,000,000 / 86,400            =        347   /s  avg
                  × 5 peak factor                =      1,736   /s  peak

Fan-out writes    500,000 tweets × 200 followers = 100,000,000 /day
                  100,000,000 / 86,400           =      1,157   /s  avg
                  × 5 peak factor                =      5,787   /s  peak

Tweet storage     500,000 × 1 KB                 =        500 MB /day
                  × 365                          =        183 GB /yr

Media storage     500,000 × 10% × 300 KB         =         15 GB /day
                  × 365                          =        5.5 TB /yr
```

**Put that in perspective:** 6 writes per second. A single unremarkable Postgres instance
handles thousands. 1,700 peak reads per second against Redis, which does 100,000+
operations per second on one node. The entire Tier 2 workload fits on hardware you could
rent for the price of a dinner out.

## The two constraints that are actually real at 1M DAU

Compute is not the binding constraint at this scale. These two are, and they are the ones
most write-ups skip.

### 1. Redis timeline memory

The naive version materialises a timeline for every registered account:

```
10M registered × 800 entries × 8 bytes  =  64 GB raw
                                        ≈ 130–190 GB with Redis list overhead
```

That forces a Redis cluster and dominates the infrastructure bill — to store timelines for
millions of accounts that have not opened the app in a year.

The fix is to notice that a timeline is a *cache*, not a record:

```
3M weekly-active × 400 entries × 8 bytes =  9.6 GB raw
                                         ≈  20–30 GB with overhead
```

Two changes, roughly a **6× reduction**: materialise only for users seen in the last seven
days, and cap at 400 entries instead of 800. A dormant user's first request after a long
absence takes the slow path and rebuilds their timeline — a rare, acceptable cost.

### 2. Media egress

Storage is the small half. Delivery is the expensive half:

```
5M media views/day × 300 KB     =  1.5 TB/day egress
                                =  547 TB/yr
at ~$0.05/GB CDN               ≈  $27,000/yr  — if every byte came from origin
with 95% CDN cache hit ratio   ≈  $1,400/yr from origin, the rest at CDN rates
```

The **cache hit ratio is the lever**, not the storage tier. This is why the Media service
exists as its own boundary with immutable, content-addressed URLs: immutable objects are
trivially cacheable, and a cache that never has to revalidate is a cache that works.

## The trigger table

For each component, the measured threshold at which it stops being premature. Read this as
the answer to "when should I have built the thing I already built".

| Add this | When |
|---|---|
| Postgres read replica | Primary CPU > 60% sustained, or replica-eligible reads > 70% of query volume |
| Redis for timelines | Timeline query p99 > 100 ms at the database |
| Async fan-out (in-process queue) | Synchronous fan-out pushes write p99 past ~150 ms |
| Kafka (replacing that queue) | Queue p99 lag > 30 s, **or** a second consumer needs the same event stream |
| Extract a service | Its deploy cadence or failure domain genuinely diverges from the monolith — not before |
| Shard the tweet table | Table > ~500 GB, or > ~5,000 writes/s sustained |
| Read-time celebrity merge | Any account's followers × tweet rate makes fan-out p99 unacceptable (~10k followers) |
| Multi-region | p99 for a geography exceeds target on network RTT alone |

Note what is missing: "when the architecture diagram looks impressive". Every row is a
number you can put on a dashboard and alert on.

## How this is verified

Phase 10 turns this page from arithmetic into measurement. The k6 suite targets the Tier 2
peak — **~3,000 RPS, p99 < 200 ms on `GET /timeline/home`** — and the README publishes the
result together with the hardware it ran on. A latency number without its hardware is not
a result.

## See also

- [`01-system-design.md`](01-system-design.md) — what these numbers argue for
- [`adr/0001-hybrid-services-over-monolith.md`](adr/0001-hybrid-services-over-monolith.md) — the decision this page most directly indicts
- [`05-roadmap.md`](05-roadmap.md) — where the measurement happens
