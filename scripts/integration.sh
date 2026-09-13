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

# The compose value, and public on purpose — it is committed in
# infra/docker/compose.yml. Having it here is what lets this script forge
# tokens, which is the only way to test a verifier honestly.
JWT_SECRET="${JWT_SECRET:-dev-only-not-a-secret-change-me-32b}"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# Mints a JWT the way identity does: two base64url segments, joined by a
# dot, HMAC-SHA256 over both. Written out because an *expired* token cannot
# be obtained by logging in and waiting fifteen minutes.
jwt() {
  local header payload signature
  header=$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)
  payload=$(printf '%s' "$1" | b64url)
  signature=$(printf '%s.%s' "$header" "$payload" |
    openssl dgst -sha256 -hmac "$JWT_SECRET" -binary | b64url)
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

get_profile() {
  curl -sS -o "$body" -w '%{http_code} %{content_type}' "$GATEWAY/v1/users/$1" 2>/dev/null
}

# $1 = JSON body, $2 = bearer token (omitted means no Authorization header
# at all, which is a different thing from an empty one).
patch_me() {
  if [ -z "${2:-}" ]; then
    curl -sS -o "$body" -w '%{http_code}' \
      -X PATCH "$GATEWAY/v1/users/me" \
      -H 'Content-Type: application/json' \
      -d "$1" 2>/dev/null
  else
    curl -sS -o "$body" -w '%{http_code}' \
      -X PATCH "$GATEWAY/v1/users/me" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer $2" \
      -d "$1" 2>/dev/null
  fi
}


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

# `pnpm up:app` returns as soon as the containers are *started*, not once
# they are healthy — it does not pass --wait, the way CI's own `up` step
# does. Running straight afterwards races the Gateway's boot and produces a
# page of failures that look like real bugs and are not. Waiting here costs
# nothing when the stack is already up.
ready=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if [ "$(curl -sS -o /dev/null -w '%{http_code}' "$GATEWAY/health" 2>/dev/null)" = "200" ]; then
    ready=yes
    break
  fi
  sleep 2
done

if [ -z "$ready" ]; then
  printf '\033[31mthe gateway never answered at %s — is `pnpm up:app` running?\033[0m\n' "$GATEWAY"
  exit 1
fi

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

# --- Public profile read ----------------------------------------------------
head_ "profile: the public read"

result=$(get_profile "$handle")
status=${result%% *}
content_type=${result#* }

if [ "$status" = "200" ]; then
  ok "a profile is readable with no Authorization header at all"
else
  bad "expected 200, got ${status:-<none>}" "$(cat "$body")"
fi

# The criterion: "exposes an identifier that does not change when the handle
# changes". Both halves matter — it has to be there, and it has to be the
# account id rather than the handle spelled differently.
profile_id=$(json_string "$body" id)
if [ -n "$profile_id" ] && [ "$profile_id" = "$user_id" ]; then
  ok "the profile exposes the account id, and it is the one login returned"
else
  bad "profile id does not match the login's userId" "profile=$profile_id login=$user_id"
fi

if grep -qE '"id":"[0-9]+"' "$body"; then
  ok "the id is a quoted string, not a JSON number"
else
  bad "id is not a quoted string" "$(cat "$body")"
fi

# Registration sets display_name to the handle and bio to ''. A bio that
# arrived absent rather than empty would make every client handle undefined.
if grep -q '"bio":""' "$body"; then
  ok "a bio nobody set is '' rather than absent"
else
  bad "bio missing or not empty on a fresh account" "$(cat "$body")"
fi

# Case-insensitivity comes from the handle column's CITEXT type. If this
# ever 404s, the lookup stopped going through that column.
result=$(get_profile "$upper")
if [ "${result%% *}" = "200" ]; then
  ok "a profile is found whatever the case of the handle"
else
  bad "expected 200 for '$upper', got ${result%% *}" "$(cat "$body")"
fi

result=$(get_profile "nosuchuser$(date +%s)")
status=${result%% *}
content_type=${result#* }

if [ "$status" = "404" ]; then
  ok "an unknown handle is not found (404)"
else
  bad "expected 404, got ${status:-<none>}" "$(cat "$body")"
fi

case "$content_type" in
*application/problem+json*) ok "the not-found uses the standard error shape" ;;
*) bad "wrong media type on the 404" "got: ${content_type:-<none>}" ;;
esac

# --- Authenticated update ---------------------------------------------------
head_ "profile: the authenticated update"

result=$(patch_me '{"displayName":"  Samuel  ","bio":"building a twitter clone"}' "$access_token")

if [ "$result" = "200" ]; then
  ok "an authenticated account updates its own profile (200)"
else
  bad "expected 200, got ${result:-<none>}" "$(cat "$body")"
fi

# Trimmed by identity's domain rules, and returned as stored — which is why
# this answers 200 with a body rather than 204 with nothing.
if grep -q '"displayName":"Samuel"' "$body"; then
  ok "the response carries the value as stored, trimmed"
else
  bad "display name was not normalised, or not returned" "$(cat "$body")"
fi

# The field-presence rule, end to end and through protobuf: an omitted field
# must not be read as an instruction to erase. This is the assertion that
# fails if `optional` is ever dropped from identity.proto.
result=$(patch_me '{"displayName":"Samuel Damatta"}' "$access_token")
if [ "$result" = "200" ] && grep -q '"bio":"building a twitter clone"' "$body"; then
  ok "renaming leaves an unmentioned bio untouched"
else
  bad "a rename erased the bio" "$(cat "$body")"
fi

# And the other half: '' is a value, not an omission.
result=$(patch_me '{"bio":""}' "$access_token")
if [ "$result" = "200" ] && grep -q '"bio":""' "$body"; then
  ok "an empty bio clears the field rather than being ignored"
else
  bad "an empty bio did not clear the field" "$(cat "$body")"
fi

stored_bio=$(psql_ "SELECT bio FROM identity.users WHERE id = $user_id;")
if [ -z "$stored_bio" ]; then
  ok "the cleared bio reached the database, and is '' rather than NULL"
else
  bad "unexpected bio in the database" "got: $stored_bio"
fi

# A patch that asks for nothing is refused rather than answered 200, so a
# mis-cased field name is a message instead of a silent no-op.
result=$(patch_me '{"displayname":"Typo"}' "$access_token")
if [ "$result" = "400" ] && ! grep -q '"field"' "$body"; then
  ok "a patch naming no known field is refused, and names no field"
else
  bad "expected a 400 with no field member, got ${result:-<none>}" "$(cat "$body")"
fi

result=$(patch_me '{"displayName":"   "}' "$access_token")
if [ "$result" = "400" ] && grep -q '"field":"displayName"' "$body"; then
  ok "a display name of only whitespace is refused, naming the field"
else
  bad "expected 400 naming displayName, got ${result:-<none>}" "$(cat "$body")"
fi

# --- One account cannot edit another ----------------------------------------
head_ "profile: the update is scoped to the token"

victim="vic$(date +%s)"
post "{\"handle\":\"$victim\",\"password\":\"$password\"}" >/dev/null
victim_id=$(json_string "$body" id)

# Every field a request could plausibly use to name someone else, sent at
# once. None of them exists in the API — the subject comes from the token —
# so the only effect must be the caller renaming itself.
result=$(patch_me "{\"userId\":\"$victim_id\",\"id\":\"$victim_id\",\"handle\":\"$victim\",\"displayName\":\"Hijacked\"}" "$access_token")

victim_name=$(psql_ "SELECT display_name FROM identity.users WHERE id = $victim_id;")
if [ "$victim_name" = "$victim" ]; then
  ok "an id in the body changes nothing about whose profile is written"
else
  bad "another account's profile was modified" "display_name is now: $victim_name"
fi

own_name=$(psql_ "SELECT display_name FROM identity.users WHERE id = $user_id;")
if [ "$result" = "200" ] && [ "$own_name" = "Hijacked" ]; then
  ok "the caller's own profile is what changed"
else
  bad "the update did not apply to the caller" "status=$result own=$own_name"
fi

# --- Rejections are indistinguishable ---------------------------------------
head_ "profile: unauthenticated and invalid tokens"

now=$(date +%s)

# An expired token cannot be had by waiting, so it is minted: correctly
# signed with the real key, and dead an hour ago.
expired=$(jwt "{\"sub\":\"$user_id\",\"sid\":\"1\",\"iat\":$((now - 7200)),\"exp\":$((now - 3600))}")
# Tampered: a genuine token with one character of its payload changed, which
# breaks the signature without changing anything else about it.
tampered=$(printf '%s' "$access_token" | awk -F. '{print $1"."substr($2,1,length($2)-1)"X."$3}')

result=$(patch_me '{"bio":"x"}')
absent_status=$result
absent_body=$(cat "$body")

result=$(patch_me '{"bio":"x"}' "$expired")
expired_status=$result
expired_body=$(cat "$body")

result=$(patch_me '{"bio":"x"}' "$tampered")
tampered_status=$result
tampered_body=$(cat "$body")

if [ "$absent_status" = "401" ] && [ "$expired_status" = "401" ] && [ "$tampered_status" = "401" ]; then
  ok "an absent, an expired and a tampered token are all refused (401)"
else
  bad "expected 401 from all three" \
    "absent=$absent_status expired=$expired_status tampered=$tampered_status"
fi

# The criterion that matters most. Not merely all 401 — the same bytes, or
# the difference tells an attacker whether the token they stole is genuine.
if [ "$absent_body" = "$expired_body" ] && [ "$expired_body" = "$tampered_body" ]; then
  ok "the three rejections are byte-for-byte identical"
else
  bad "the rejections differ" \
    "absent: $absent_body  expired: $expired_body  tampered: $tampered_body"
fi

if ! printf '%s' "$expired_body" | grep -qE '"detail"|"field"'; then
  ok "no rejection carries a detail or a field"
else
  bad "a rejection says why" "$expired_body"
fi

# The forged token proves the *verifier* works. This proves the two sides
# agree: a token minted by this script with the same key and the same format
# is accepted, so identity's issuer and the Gateway's verifier are speaking
# the same language — which no unit test on either side can establish.
live=$(jwt "{\"sub\":\"$user_id\",\"sid\":\"1\",\"iat\":$now,\"exp\":$((now + 900))}")
result=$(patch_me '{"bio":"minted by the test"}' "$live")
if [ "$result" = "200" ]; then
  ok "a token minted with the shared key is accepted, so issuer and verifier agree"
else
  bad "the verifier rejected a correctly signed token" "status=$result $(cat "$body")"
fi

# A signature is checked with the key, never trusted from the header.
# `alg: none` is the oldest JWT attack there is.
alg_none_header=$(printf '%s' '{"alg":"none","typ":"JWT"}' | b64url)
alg_none_payload=$(printf '%s' "{\"sub\":\"$user_id\",\"sid\":\"1\",\"iat\":$now,\"exp\":$((now + 900))}" | b64url)
result=$(patch_me '{"bio":"forged"}' "$alg_none_header.$alg_none_payload.")
if [ "$result" = "401" ]; then
  ok "a token claiming alg: none is refused"
else
  bad "an unsigned token was accepted" "status=$result"
fi

# RFC 7235 requires a 401 to say how to authenticate. RFC 6750 defines
# error="invalid_token" for this header — its absence is deliberate, since
# it would say which failure it was.
auth_header=$(curl -sS -o /dev/null -D - \
  -X PATCH "$GATEWAY/v1/users/me" \
  -H 'Content-Type: application/json' \
  -d '{"bio":"x"}' 2>/dev/null | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: //p')

if [ "$auth_header" = "Bearer" ]; then
  ok "the 401 carries WWW-Authenticate, bare, with no error parameter"
else
  bad "unexpected WWW-Authenticate" "got: ${auth_header:-<none>}"
fi

# What the guard does *not* get to decide, pinned so it cannot drift
# silently. Express's JSON parser is global (see gateway main.ts), so it
# runs before Nest's pipeline exists and therefore before any guard: a
# malformed body with no token is a 400, not a 401.
#
# Accepted rather than fixed. It says nothing about the token or about any
# account — a caller holding a perfectly good token gets the same 400 — and
# the work it admits is capped by the parser's own 100 kB limit. See the
# comment on AccessTokenGuard.
result=$(curl -sS -o "$body" -w '%{http_code}' \
  -X PATCH "$GATEWAY/v1/users/me" \
  -H 'Content-Type: application/json' \
  -d '{"bio":' 2>/dev/null)

if [ "$result" = "400" ]; then
  ok "a malformed body is refused by the parser before the guard sees it (400)"
else
  bad "expected 400 from the body parser, got ${result:-<none>}" "$(cat "$body")"
fi

# The same request with a *well-formed* body is a 401, which is what makes
# the 400 above a property of the parser rather than of authentication.
result=$(patch_me '{"bio":"x"}')
if [ "$result" = "401" ]; then
  ok "the same request with a valid body is a 401, so the 400 is the parser's"
else
  bad "expected 401, got ${result:-<none>}" "$(cat "$body")"
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

# --- Verification is local --------------------------------------------------
head_ "profile: the Gateway verifies without calling identity"

# The acceptance criterion that nothing else in this file can reach: the
# Gateway must decide a token on its own, with no network hop. The only
# honest way to test that is to take identity away and see what still works.
#
# Two assertions, and neither means much alone. A 401 with identity down
# could just as easily be a broken Gateway; a 503 could be a Gateway that
# always calls out. Together they say exactly one thing: the token was
# judged locally, and the request only goes downstream once it passed.
#
# Last in the file on purpose — everything above has already run, so a
# failure to bring identity back cannot invalidate it.
$COMPOSE stop identity >/dev/null 2>&1

result=$(patch_me '{"bio":"x"}' "$tampered")
if [ "$result" = "401" ]; then
  ok "a bad token is still refused with identity stopped — no hop was needed"
else
  bad "expected 401 with identity down, got ${result:-<none>}" "$(cat "$body")"
fi

result=$(patch_me '{"bio":"x"}' "$access_token")
if [ "$result" = "503" ] || [ "$result" = "504" ]; then
  ok "a good token gets as far as the unreachable identity (${result})"
else
  bad "expected 503/504 with identity down, got ${result:-<none>}" "$(cat "$body")"
fi

# A public profile read is identity's too, so it fails the same way. Stated
# rather than assumed: it is what makes the 503 above a property of the
# missing service and not of the PATCH route.
result=$(get_profile "$handle")
if [ "${result%% *}" = "503" ] || [ "${result%% *}" = "504" ]; then
  ok "the public read needs identity, which is why the 503 above means what it says"
else
  bad "expected 503/504 on the public read, got ${result%% *}"
fi

$COMPOSE start identity >/dev/null 2>&1

# Back to healthy before this script exits, so a second run does not start
# against a stopped service.
restored=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  sleep 2
  if [ "$(get_profile "$handle" | cut -d' ' -f1)" = "200" ]; then
    restored=yes
    break
  fi
done

if [ -n "$restored" ]; then
  ok "identity is back, and the stack is left as it was found"
else
  bad "identity did not come back — run 'pnpm up:app' before trusting the next run"
fi

# --- Result -----------------------------------------------------------------
echo
if [ "$fail" -gt 0 ]; then
  printf '\033[1m%d passed, \033[31m%d failed\033[0m\n' "$pass" "$fail"
  exit 1
fi
printf '\033[1m%d passed, 0 failed\033[0m\n' "$pass"
