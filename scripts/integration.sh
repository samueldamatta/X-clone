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

login() {
  curl -sS -o "$body" -w '%{http_code} %{content_type}' \
    -X POST "$GATEWAY/v1/auth/login" \
    -H 'Content-Type: application/json' \
    -d "$1" 2>/dev/null
}

psql_() { $COMPOSE exec -T postgres psql -qtAX -U postgres -d xclone -c "$1" 2>&1; }

# Reads one top-level string from a JSON object. Good enough for the flat,
# server-generated responses this script checks, and it keeps the script's
# only dependency curl — jq is not installed everywhere this runs.
json_string() { sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" "$1"; }

# base64url -> base64, padded, then decoded. A JWT segment is base64url, and
# `base64 -d` only speaks base64.
b64url_decode() {
  local input=$1
  input=$(printf '%s' "$input" | tr '_-' '/+')
  case $((${#input} % 4)) in
  2) input="$input==" ;;
  3) input="$input=" ;;
  esac
  printf '%s' "$input" | base64 -d 2>/dev/null
}

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

# --- Login ------------------------------------------------------------------
head_ "login"

result=$(login "{\"handle\":\"$handle\",\"password\":\"$password\"}")
status=${result%% *}

if [ "$status" = "200" ]; then
  ok "valid credentials are accepted (200)"
else
  bad "expected 200, got ${status:-<none>}" "$(cat "$body")"
fi

access_token=$(json_string "$body" accessToken)
refresh_token=$(json_string "$body" refreshToken)
user_id=$(json_string "$body" userId)

if [ -n "$access_token" ] && [ -n "$refresh_token" ]; then
  ok "the response carries both an access and a refresh token"
else
  bad "a token is missing from the response" "$(cat "$body")"
fi

# Three dot-separated segments is what makes it a JWT rather than an opaque
# string — and it is what lets the Gateway verify it without a network hop.
jwt_segments=$(printf '%s' "$access_token" | awk -F. '{print NF}')
if [ "$jwt_segments" = "3" ]; then
  ok "the access token is a three-segment JWT"
else
  bad "the access token is not a JWT" "segments: ${jwt_segments:-0}"
fi

claims=$(b64url_decode "$(printf '%s' "$access_token" | cut -d. -f2)")

# The account identifier, as the acceptance criterion requires — and as a
# *string*, because a Snowflake above 2^53-1 does not survive a JSON number.
if printf '%s' "$claims" | grep -q "\"sub\":\"$user_id\""; then
  ok "the access token carries the account id, quoted as a string"
else
  bad "sub does not match the returned userId" "claims: $claims  userId: $user_id"
fi

# The lifetime published in docs/04-api-contracts.md, read off a real token.
iat=$(printf '%s' "$claims" | sed -n 's/.*"iat":\([0-9]*\).*/\1/p')
exp=$(printf '%s' "$claims" | sed -n 's/.*"exp":\([0-9]*\).*/\1/p')
if [ -n "$iat" ] && [ -n "$exp" ] && [ "$((exp - iat))" = "900" ]; then
  ok "the access token expires 15 minutes after it was issued"
else
  bad "unexpected access token lifetime" "iat=${iat:-?} exp=${exp:-?}"
fi

# The refresh token is opaque: it must not be a JWT, and must carry nothing
# readable. If this ever parses, someone made it self-describing.
if [ "$(printf '%s' "$refresh_token" | awk -F. '{print NF}')" = "1" ]; then
  ok "the refresh token is opaque, not a second JWT"
else
  bad "the refresh token looks structured" "got: $refresh_token"
fi

# --- Account enumeration ----------------------------------------------------
head_ "login rejections"

# The criterion that matters most here. An unknown handle and a wrong
# password must be indistinguishable — not merely both 401, but the same
# bytes, or the difference is the answer to "does this handle exist?".
result=$(login "{\"handle\":\"$handle\",\"password\":\"wrong-password1\"}")
wrong_password_status=${result%% *}
wrong_password_body=$(cat "$body")

result=$(login "{\"handle\":\"nosuchuser$(date +%s)\",\"password\":\"$password\"}")
unknown_handle_status=${result%% *}
unknown_handle_body=$(cat "$body")

if [ "$wrong_password_status" = "401" ] && [ "$unknown_handle_status" = "401" ]; then
  ok "both a wrong password and an unknown handle are refused (401)"
else
  bad "expected 401 from both" "wrong=$wrong_password_status unknown=$unknown_handle_status"
fi

if [ "$wrong_password_body" = "$unknown_handle_body" ]; then
  ok "the two rejections are byte-for-byte identical"
else
  bad "the rejections differ, which enumerates accounts" \
    "wrong: $wrong_password_body   unknown: $unknown_handle_body"
fi

# A `field` member would name `handle` or `password` and give away exactly
# the distinction the identical bodies above are protecting.
if ! printf '%s' "$unknown_handle_body" | grep -q '"field"'; then
  ok "neither rejection names a field"
else
  bad "the rejection names a field" "$unknown_handle_body"
fi

# --- Sessions ---------------------------------------------------------------
head_ "sessions"

# A second login, so "logging in twice yields two independent sessions" is
# checked against rows rather than assumed.
result=$(login "{\"handle\":\"$handle\",\"password\":\"$password\"}")
second_refresh=$(json_string "$body" refreshToken)

if [ "${result%% *}" = "200" ] && [ "$second_refresh" != "$refresh_token" ]; then
  ok "logging in twice mints two different refresh tokens"
else
  bad "the second login did not produce a fresh token" "$(cat "$body")"
fi

sessions=$(psql_ "SELECT count(*) FROM identity.sessions WHERE user_id = $user_id;")
if [ "$sessions" = "2" ]; then
  ok "two independent session rows exist for this account"
else
  bad "expected 2 session rows, found ${sessions:-<none>}"
fi

# Independent means neither login disturbed the other. If the second had
# rotated or revoked the first, this would be 1.
live=$(psql_ "SELECT count(*) FROM identity.sessions
              WHERE user_id = $user_id AND revoked_at IS NULL;")
if [ "$live" = "2" ]; then
  ok "both sessions are live — signing in twice revokes nothing"
else
  bad "expected 2 live sessions, found ${live:-<none>}"
fi

distinct=$(psql_ "SELECT count(DISTINCT refresh_token_hash) FROM identity.sessions
                  WHERE user_id = $user_id;")
if [ "$distinct" = "2" ]; then
  ok "each session stores its own distinct token hash"
else
  bad "session hashes are not distinct" "got: ${distinct:-<none>}"
fi

# The whole reason the column holds a hash. Both halves matter: the token
# must be absent, and the row must exist — an empty table would satisfy the
# first on its own.
leaked=$(psql_ "SELECT count(*) FROM identity.sessions
                WHERE refresh_token_hash LIKE '%$refresh_token%';")
hashed=$(psql_ "SELECT count(*) FROM identity.sessions
                WHERE user_id = $user_id AND refresh_token_hash ~ '^[0-9a-f]{64}\$';")
if [ "$leaked" = "0" ] && [ "$hashed" = "2" ]; then
  ok "only hashes are stored — the refresh token itself is nowhere in the table"
else
  bad "refresh token storage is wrong" "leaked=${leaked:-?} hashed=${hashed:-?}"
fi

# Nothing anywhere in the row, not just in the hash column: a token parked
# in user_agent would be just as leaked.
anywhere=$(psql_ "SELECT count(*) FROM identity.sessions
                  WHERE sessions::text LIKE '%$refresh_token%';")
if [ "$anywhere" = "0" ]; then
  ok "the refresh token appears in no column of the sessions table"
else
  bad "the refresh token is stored somewhere in the row"
fi

# curl sends a User-Agent, and the session records whatever the client sent.
agents=$(psql_ "SELECT count(*) FROM identity.sessions
                WHERE user_id = $user_id AND user_agent LIKE 'curl/%';")
if [ "$agents" = "2" ]; then
  ok "each session recorded the client's user agent"
else
  bad "user_agent was not recorded" "got: ${agents:-<none>}"
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
