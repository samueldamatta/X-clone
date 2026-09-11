#!/usr/bin/env bash
# Exercises POST /v1/auth/register against the containerised services, the way
# a client would: over HTTP, through the Gateway, with nothing stubbed.
#
# This is the only test in the repository that proves the parts fit together.
# Unit tests prove each half behaves; they cannot prove the .proto loads inside
# the image, that compose's DNS resolves `identity`, that the migration ran
# under identity_svc, or that argon2 has a binary for the image's libc. Every
# one of those has exactly one failure mode: it works locally and not in CI.
#
# Run after `pnpm up:app`. bash 3.2 compatible (macOS ships 3.2; CI runs 5).
set -uo pipefail

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f infra/docker/compose.yml"
GATEWAY="${GATEWAY_URL:-http://127.0.0.1:8080}"

pass=0
fail=0

ok() {
  printf '  \033[32m✓\033[0m  %s\n' "$1"
  pass=$((pass + 1))
}
bad() {
  printf '  \033[31m✗\033[0m  %s\n' "$1"
  [ -n "${2:-}" ] && printf '       %s\n' "$2"
  fail=$((fail + 1))
}
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

body=$(mktemp)
trap 'rm -f "$body"' EXIT

# Status and content type out of band, body to a file — so a body containing a
# newline cannot be mistaken for the status line.
post() {
  curl -sS -o "$body" -w '%{http_code} %{content_type}' \
    -X POST "$GATEWAY/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -d "$1" 2>/dev/null
}

psql_() { $COMPOSE exec -T postgres psql -qtAX -U postgres -d xclone -c "$1" 2>&1; }

# Unique per run, so this can be run twice without `down -v` between. Handles
# are 3-20 characters of [a-zA-Z0-9_] — see identity's domain/handle.ts.
handle="ci$(date +%s)"
password='correcthorse1'

# --- The happy path ---------------------------------------------------------
head_ "register"

result=$(post "{\"handle\":\"$handle\",\"password\":\"$password\"}")
status=${result%% *}

if [ "$status" = "201" ]; then
  ok "an unused handle is created (201)"
else
  bad "expected 201, got ${status:-<none>}" "$(cat "$body")"
fi

# The id must be a JSON *string*. As a number, a Snowflake silently loses
# precision above 2^53-1 in every JavaScript client — docs/adr/0005-snowflake-ids.md.
if grep -qE '"id":"[0-9]+"' "$body"; then
  ok "the id is a string, not a number"
else
  bad "id is not a quoted string" "$(cat "$body")"
fi

if grep -q "\"handle\":\"$handle\"" "$body"; then
  ok "the response carries the handle that was registered"
else
  bad "handle missing from the response" "$(cat "$body")"
fi

# --- Rejections -------------------------------------------------------------
head_ "rejections"

# Upper-cased: uniqueness is enforced by the handle column's CITEXT type, not
# by application code. If this ever returns 201, the column type is wrong.
upper=$(printf '%s' "$handle" | tr '[:lower:]' '[:upper:]')
result=$(post "{\"handle\":\"$upper\",\"password\":\"$password\"}")
status=${result%% *}
content_type=${result#* }

if [ "$status" = "409" ]; then
  ok "a handle already taken is rejected, ignoring case (409)"
else
  bad "expected 409 for '$upper', got ${status:-<none>}" "$(cat "$body")"
fi

case "$content_type" in
*application/problem+json*) ok "failures are served as application/problem+json" ;;
*) bad "wrong media type on a failure" "got: ${content_type:-<none>}" ;;
esac

if grep -q '"field":"handle"' "$body"; then
  ok "the conflict names the offending field"
else
  bad "no field member on the 409" "$(cat "$body")"
fi

# Identity's rule, reached over the wire. The Gateway deliberately does not
# restate it — see presentation/http/register.request.ts.
result=$(post "{\"handle\":\"${handle}b\",\"password\":\"abc\"}")
status=${result%% *}

if [ "$status" = "400" ] && grep -q '"field":"password"' "$body"; then
  ok "a too-weak password is refused (400)"
else
  bad "expected 400 naming password, got ${status:-<none>}" "$(cat "$body")"
fi

# The criterion is "rejected *before an account is created*". The 400 above is
# only half of that: a bug that inserted the user and then failed would answer
# 400 too. This is the other half.
created=$(psql_ "SELECT count(*) FROM identity.users WHERE handle = '${handle}b';")
if [ "$created" = "0" ]; then
  ok "no account was created for the rejected password"
else
  bad "the rejected registration left $created row(s) behind"
fi

result=$(post "{\"handle\":\"${handle}c\"}")
status=${result%% *}

if [ "$status" = "400" ] && grep -q '"field":"password"' "$body"; then
  ok "a missing field is named rather than reported generically"
else
  bad "expected 400 naming password, got ${status:-<none>}" "$(cat "$body")"
fi

# V8's JSON errors quote the input. A malformed body carrying a password must
# not put that password in the response — see presentation/http/json-body.ts.
result=$(curl -sS -o "$body" -w '%{http_code}' \
  -X POST "$GATEWAY/v1/auth/register" \
  -H 'Content-Type: application/json' \
  -d '{"handle":"sam","password":"hunter2' 2>/dev/null)

if [ "$result" = "400" ] && ! grep -q 'hunter2' "$body"; then
  ok "a malformed body is refused without quoting it back"
else
  bad "malformed body handled wrongly (status $result)" "$(cat "$body")"
fi

# --- What reached the database ----------------------------------------------
head_ "storage"

# The point of the per-service role, stated as a test. Anything outside
# identity.* means a migration created a table it had no business creating.
schemas=$(psql_ "SELECT DISTINCT schemaname FROM pg_tables
                 WHERE schemaname NOT IN ('pg_catalog','information_schema');")
if [ "$schemas" = "identity" ]; then
  ok "migrations created tables in identity.* and nowhere else"
else
  bad "tables exist outside identity.*" "got: ${schemas:-<none>}"
fi

owners=$(psql_ "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname='identity';")
if [ "$owners" = "identity_svc" ]; then
  ok "every identity table is owned by identity_svc, not by the superuser"
else
  bad "unexpected table owner" "got: ${owners:-<none>}"
fi

stored=$(psql_ "SELECT c.password_hash FROM identity.credentials c
                JOIN identity.users u ON u.id = c.user_id WHERE u.handle = '$handle';")
case "$stored" in
'$argon2id$'*) ok "the password is stored as an argon2id hash" ;;
*) bad "password_hash is not argon2id" "got: ${stored:0:24}" ;;
esac

# Both halves matter. Counting zero matches proves nothing on its own — an
# empty table would satisfy it — so the row this run created has to be there.
rows=$(psql_ "SELECT count(*) FROM identity.credentials c
              JOIN identity.users u ON u.id = c.user_id WHERE u.handle = '$handle';")
leaked=$(psql_ "SELECT count(*) FROM identity.credentials WHERE password_hash LIKE '%$password%';")

if [ "$rows" = "1" ] && [ "$leaked" = "0" ]; then
  ok "the credential row exists, and the password is not recoverable from it"
else
  bad "expected 1 credential row and 0 leaks" "rows=${rows:-?} leaked=${leaked:-?}"
fi

# --- Result -----------------------------------------------------------------
echo
if [ "$fail" -gt 0 ]; then
  printf '\033[1m%d passed, \033[31m%d failed\033[0m\n' "$pass" "$fail"
  exit 1
fi
printf '\033[1m%d passed, 0 failed\033[0m\n' "$pass"
