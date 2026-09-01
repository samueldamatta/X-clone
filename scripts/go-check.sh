#!/usr/bin/env bash
# Runs gofmt, vet, build and test across every module in go.work.
#
# Why this is not just `go vet ./...`: in a Go workspace, a relative pattern only
# resolves if the directory prefix itself contains a module. Nothing at the repo
# root does — the modules live at backend/services/<svc> — so `./...` and even
# `./backend/...` fail with "directory prefix does not contain modules listed in
# go.work". `go vet all` would work but also pulls in every dependency of every
# module, which is not what we want to lint.
#
# Iterating the workspace's own module list is the version that stays correct
# when a fourth Go service arrives.
#
# Written for bash 3.2, which is what macOS ships: no mapfile, no associative
# arrays. CI runs bash 5, so anything newer would pass there and fail here.
set -euo pipefail

cd "$(dirname "$0")/.."

dirs=""
while IFS= read -r dir; do
  dirs="$dirs $dir"
done < <(go list -f '{{.Dir}}' -m)

if [ -z "$dirs" ]; then
  echo "no modules in go.work" >&2
  exit 1
fi

echo "==> gofmt"
# shellcheck disable=SC2086
unformatted=$(gofmt -l $dirs)
if [ -n "$unformatted" ]; then
  echo "not gofmt'd:" >&2
  echo "$unformatted" >&2
  exit 1
fi
echo "    ok"

out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

count=0
for dir in $dirs; do
  echo "==> $(basename "$dir")"
  # -o into a throwaway dir: a bare `go build ./...` drops the compiled binary
  # into the module root, where it is one `git add -A` away from being committed.
  ( cd "$dir" && go vet ./... && go build -o "$out/" ./... && go test ./... )
  count=$((count + 1))
done

echo
echo "all $count modules ok"
