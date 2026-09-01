# infra

One directory per tool. `compose.yml` holds the topology and nothing else; everything a
container needs to know about *this* system lives in that tool's directory and is mounted
read-only.

```
infra/
├── docker/compose.yml              the topology — what runs, on which ports, in which order
├── postgres/init/01-schemas.sql    schemas, roles, extensions (no tables — see below)
├── otel/collector.yml              the telemetry pipeline: receivers → processors → exporters
├── prometheus/prometheus.yml       what to scrape
├── grafana/provisioning/           datasources and the dashboard provider
└── k8s/                            Phase 11
```

## Why these files exist at all

Every image here is a generic binary that knows nothing about X-clone. Prometheus does not
know what to scrape; Grafana does not know where the data is; the collector does not know
where to send a span. These files are what teach them, and they reach the container through
a read-only bind mount:

```yaml
- ../otel/collector.yml:/etc/otel/collector.yml:ro
#  ↑ path on your disk    ↑ path inside the container
```

Edit locally, restart the container, done. Nothing is baked into an image.

## Why configuration is a file and not a click

Grafana would happily let you add a datasource through the browser. Two things break.

`pnpm reset` destroys the volume, so you would reconfigure it by hand every time. Worse, a
datasource created in the UI gets a random UID, and a dashboard referencing
`uid: a7f3b2c1` then works on exactly one machine. `datasources.yml` pins `uid: prometheus`
so a committed dashboard means the same thing everywhere.

## What each file does

| File | Teaches its container |
|---|---|
| `postgres/init/01-schemas.sql` | Five schemas, five roles, `citext`. Runs **once**, on an empty data directory |
| `otel/collector.yml` | Accept OTLP on `:4317`/`:4318`, batch it, send traces to Jaeger and expose metrics on `:8889` |
| `prometheus/prometheus.yml` | Scrape the collector and itself. Services are added by the phase that introduces them |
| `grafana/provisioning/datasources` | Prometheus and Jaeger, at fixed UIDs |
| `grafana/provisioning/dashboards` | Where to look for dashboards. The folder is empty until Phase 9 |

## Why `01-schemas.sql` creates no tables

It runs only when the Postgres data directory is empty — the second time, the volume exists
and Postgres skips `/docker-entrypoint-initdb.d` entirely. DDL here would therefore work
exactly once, and leave no way to evolve it afterwards. Tables belong to the service that
owns them and arrive through that service's migrations.

What *cannot* be a migration is what the file does contain, because of a bootstrap cycle:
`tweet_svc` cannot create the role `tweet_svc`, and it must not hold `CREATE SCHEMA` on the
database — that permission is not per-schema, so a service holding it could build inside
`identity` too, which is the isolation this file exists to establish.

## See also

- [`../docs/concepts/local-environment.md`](../docs/concepts/local-environment.md) — why
  Compose and not a VM or kind, plus Kafka's advertised listeners
- [`../docs/diagrams/03-local-environment-light.svg`](../docs/diagrams/) — the port map,
  which `compose.yml` follows rather than defines
