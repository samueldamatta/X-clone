#!/usr/bin/env bash
# Proves the local environment actually works, rather than that its containers
# reached "running" — which is a much weaker claim than it looks. A Postgres
# with no schemas, a Redpanda that cannot accept a produce, and a collector
# whose spans go nowhere all report themselves as up.
#
# Run after `pnpm up`. bash 3.2 compatible.
set -uo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f infra/docker/compose.yml"
pass=0
fail=0

ok()   { printf '  \033[32m✓\033[0m  %s\n' "$1"; pass=$((pass + 1)); }
bad()  { printf '  \033[31m✗\033[0m  %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; fail=$((fail + 1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

psql_() { $COMPOSE exec -T postgres psql -qtAX -U postgres -d xclone -c "$1" 2>&1; }

# --- Postgres ---------------------------------------------------------------
head_ "postgres"

schemas=$(psql_ "SELECT string_agg(nspname, ',' ORDER BY nspname) FROM pg_namespace
                 WHERE nspname IN ('identity','graph','tweet','media','notification');")
if [ "$schemas" = "graph,identity,media,notification,tweet" ]; then
  ok "five service schemas exist"
else
  bad "service schemas missing" "got: ${schemas:-<none>}"
fi

if [ "$(psql_ "SELECT 1 FROM pg_extension WHERE extname='citext';")" = "1" ]; then
  ok "citext extension installed"
else
  bad "citext extension missing" "identity.users.handle needs it"
fi

roles=$(psql_ "SELECT count(*) FROM pg_roles WHERE rolname LIKE '%\_svc';")
if [ "$roles" = "5" ]; then
  ok "five per-service roles exist"
else
  bad "expected 5 *_svc roles, found ${roles:-0}"
fi

# The point of the roles, stated as a test: tweet_svc must not be able to read
# identity's tables. If this ever passes, the service boundary has quietly
# become a naming convention.
psql_ "CREATE TABLE IF NOT EXISTS identity.smoke_probe (id INT);" >/dev/null
denied=$($COMPOSE exec -T -e PGPASSWORD=tweet_svc_dev postgres \
  psql -qtAX -U tweet_svc -d xclone -c "SELECT 1 FROM identity.smoke_probe;" 2>&1)
if echo "$denied" | grep -qi "permission denied"; then
  ok "tweet_svc is refused access to identity.* (boundary enforced)"
else
  bad "tweet_svc could reach identity.*" "grants are too broad: $denied"
fi
psql_ "DROP TABLE IF EXISTS identity.smoke_probe;" >/dev/null

# --- Redis ------------------------------------------------------------------
head_ "redis"

if [ "$($COMPOSE exec -T redis redis-cli ping 2>&1 | tr -d '\r')" = "PONG" ]; then
  ok "responds to PING"
else
  bad "no PONG"
fi

$COMPOSE exec -T redis redis-cli set smoke:probe ok EX 30 >/dev/null 2>&1
if [ "$($COMPOSE exec -T redis redis-cli get smoke:probe 2>&1 | tr -d '\r')" = "ok" ]; then
  ok "SET/GET round-trips"
else
  bad "SET/GET failed"
fi

# Persistence is off on purpose: every Redis key here is a cache. Asserting it
# keeps someone from turning on AOF to "fix" a cold start and quietly making
# Redis a system of record.
if [ -z "$($COMPOSE exec -T redis redis-cli config get save 2>&1 | sed -n '2p' | tr -d '\r')" ]; then
  ok "persistence disabled (Redis is a cache, by design)"
else
  bad "RDB snapshots are on" "docs/03-data-model.md says every Redis key is a cache"
fi

# --- Redpanda ---------------------------------------------------------------
head_ "redpanda"

if $COMPOSE exec -T redpanda rpk cluster health 2>&1 | grep -qE 'Healthy:.+true'; then
  ok "cluster reports healthy"
else
  bad "cluster unhealthy"
fi

$COMPOSE exec -T redpanda rpk topic delete smoke.probe >/dev/null 2>&1
if $COMPOSE exec -T redpanda rpk topic create smoke.probe -p 1 >/dev/null 2>&1; then
  ok "can create a topic"
  if echo "hello" | $COMPOSE exec -T redpanda rpk topic produce smoke.probe >/dev/null 2>&1; then
    got=$($COMPOSE exec -T redpanda rpk topic consume smoke.probe -n 1 -o 0 -f '%v' 2>/dev/null | tr -d '\r\n')
    if [ "$got" = "hello" ]; then
      ok "produce → consume round-trips"
    else
      bad "consumed '$got', expected 'hello'"
    fi
  else
    bad "produce failed"
  fi
  $COMPOSE exec -T redpanda rpk topic delete smoke.probe >/dev/null 2>&1
else
  bad "topic creation failed"
fi

# --- Observability pipeline -------------------------------------------------
# The only end-to-end assertion in this file: a span pushed to the collector on
# :4318 has to come back out of Jaeger's query API. Everything between those two
# points — the OTLP receiver, the batch processor, the exporter, Jaeger's
# ingest — is covered by exactly one test, and none of it by any other.
head_ "otel-collector → jaeger"

trace_id=$(openssl rand -hex 16)
span_id=$(openssl rand -hex 8)
now_ns=$(( $(date +%s) * 1000000000 ))

payload=$(cat <<JSON
{"resourceSpans":[{"resource":{"attributes":[
  {"key":"service.name","value":{"stringValue":"smoke-test"}}]},
 "scopeSpans":[{"spans":[{
  "traceId":"$trace_id","spanId":"$span_id","name":"smoke-probe","kind":1,
  "startTimeUnixNano":"$now_ns","endTimeUnixNano":"$((now_ns + 1000000))"}]}]}]}
JSON
)

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST http://localhost:4318/v1/traces \
  -H 'Content-Type: application/json' -d "$payload" 2>/dev/null)
if [ "$code" = "200" ]; then
  ok "collector accepted an OTLP span over HTTP"
else
  bad "collector rejected the span (HTTP ${code:-no response})"
fi

# The batch processor holds spans for up to 5s, so this cannot be immediate.
found=""
i=0
while [ $i -lt 15 ]; do
  if curl -sf "http://localhost:16686/api/traces/$trace_id" 2>/dev/null | grep -q "$span_id"; then
    found=yes
    break
  fi
  sleep 2
  i=$((i + 1))
done
if [ -n "$found" ]; then
  ok "span arrived in jaeger (traceId $trace_id)"
else
  bad "span never reached jaeger" "collector took it but the export failed"
fi

# --- Prometheus & Grafana ---------------------------------------------------
head_ "prometheus / grafana"

up=$(curl -sf 'http://localhost:9090/api/v1/query?query=up' 2>/dev/null \
     | grep -o '"value"' | wc -l | tr -d ' ')
if [ "${up:-0}" -ge 1 ]; then
  ok "prometheus is scraping ($up targets reporting up)"
else
  bad "prometheus has no live targets"
fi

if curl -sf http://localhost:3001/api/health 2>/dev/null | grep -q '"database": *"ok"'; then
  ok "grafana is healthy"
else
  bad "grafana health check failed"
fi

ds=$(curl -sf -u admin:admin http://localhost:3001/api/datasources 2>/dev/null \
     | grep -o '"uid":"[a-z]*"' | sort -u | tr '\n' ' ')
if echo "$ds" | grep -q prometheus && echo "$ds" | grep -q jaeger; then
  ok "both datasources provisioned"
else
  bad "datasources not provisioned" "got: ${ds:-<none>}"
fi

# --- Result -----------------------------------------------------------------
printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
