#!/usr/bin/env bash
# Checks that every port the local environment claims is actually free, and says
# precisely how to free the ones that are not.
#
# This exists because the port map in docs/diagrams/03-local-environment.svg
# assumes a clean machine, and no developer has one. On the machine this was
# written on, three of these were already taken: postgres and an Evolution API
# from an unrelated compose project, plus a Homebrew redis running as a
# LaunchAgent — which `docker compose down` does not touch, and which therefore
# produces the most confusing failure of the three.
#
# bash 3.2 compatible (macOS ships 3.2; CI runs 5).
set -uo pipefail

cd "$(dirname "$0")/.."

# "port service profile" — profile is empty for the core set.
PORTS="
5432 postgres
6379 redis
9092 redpanda
8090 redpanda-console
8080 gateway app
8081 identity app
4317 otel-collector-grpc
4318 otel-collector-http
16686 jaeger-ui
9090 prometheus
3001 grafana
9000 minio-api media
9001 minio-console media
9200 opensearch search
"

want_profile="${1:-core}"

# Reports how to free $1, given the process name in $2.
explain() {
  port="$1"
  proc="$2"

  container=$(docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null | head -1)
  if [ -n "$container" ]; then
    project=$(docker inspect "$container" \
      --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)
    if [ -n "$project" ] && [ "$project" != "xclone" ]; then
      echo "      held by compose project '$project' (container $container)"
      echo "      free it:  docker compose -p $project stop"
    elif [ "$project" = "xclone" ]; then
      echo "      held by this project's own container $container — already up?"
      echo "      free it:  pnpm down"
    else
      echo "      held by container $container"
      echo "      free it:  docker stop $container"
    fi
    return
  fi

  # Not a container. A Homebrew service is the other common case, and the one
  # that survives every docker command you think to try.
  svc=$(brew services list 2>/dev/null | awk '$2=="started"{print $1}' \
        | grep -i "^${proc%%-*}" | head -1)
  if [ -n "$svc" ]; then
    echo "      held by Homebrew service '$svc' (a LaunchAgent, not a container)"
    echo "      free it:  brew services stop $svc"
    return
  fi

  pid=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)
  echo "      held by '$proc' (pid $pid)"
  echo "      free it:  kill $pid"
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

conflicts=0
checked=0

echo "==> port preflight (profile: $want_profile)"

echo "$PORTS" | while read -r port service profile; do
  [ -z "${port:-}" ] && continue
  case "$want_profile" in
    full) : ;;
    core) [ -n "${profile:-}" ] && continue ;;
    *)    [ "${profile:-}" != "$want_profile" ] && [ -n "${profile:-}" ] && continue ;;
  esac
  echo "$port $service"
done > "$tmp"

while read -r port service; do
  checked=$((checked + 1))
  proc=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | awk 'NR==2{print $1}')
  if [ -n "$proc" ]; then
    conflicts=$((conflicts + 1))
    printf '  \033[31m✗\033[0m  :%-6s %s\n' "$port" "$service"
    explain "$port" "$proc"
  else
    printf '  \033[32m✓\033[0m  :%-6s %s\n' "$port" "$service"
  fi
done < "$tmp"

rm -f "$tmp"

echo
if [ "$conflicts" -gt 0 ]; then
  echo "$conflicts of $checked ports are taken. Free them, then run this again."
  exit 1
fi
echo "all $checked ports free"
