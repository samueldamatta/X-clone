# Access and refresh tokens

> **Scope.** This covers two tokens of different natures, why a failed login must give
> nothing away, and how a refresh token that works exactly once turns a stolen copy into
> evidence ([#8](https://github.com/samueldamatta/X-clone/issues/8)). Token-bucket rate
> limiting ([#10](https://github.com/samueldamatta/X-clone/issues/10)) belongs here too and
> is not written yet — it arrives with the code that makes it real.

## The problem

Someone types a password once. After that, every request they make — loading a timeline,
posting, liking — has to prove who they are, without asking for the password again.

Two numbers decide everything about how.

From [`02-capacity-estimation.md`](../02-capacity-estimation.md), the timeline read path at
Tier 2 runs at **350 requests a second on average and 1,700 at peak**. Every one of them is
authenticated. Whatever proving identity costs is paid on the hottest path in the system,
and it is the peak number that decides whether the design holds.

And people get robbed. A token leaks — copied off a compromised laptop, pulled out of a log
file, lifted by a malicious browser extension. Whatever is handed out has to be something
the damage of which can be contained.

Those two pull in opposite directions. Checking cheaply means not asking anyone; containing
damage means being able to take it back, and you cannot take back something nobody checks
with you.

## Why the obvious answers fail

### A session id in a cookie, looked up on every request

The oldest answer, and it is genuinely good at the second problem. The session lives in a
table. Revoking it is an `UPDATE`. Log out on a stolen laptop and the thief's next request
fails immediately.

It breaks on the first number. Every authenticated request becomes a lookup in Identity's
store — 1,700 a second, on top of the timeline work itself. Put Redis in front and it is
fast, but it is still a network hop on every request, and it makes Identity a hard
dependency of *reading a timeline*: when Identity is down, nobody can read anything, even
though nothing about a timeline needs Identity to be up.

That is a strange trade to make. The Gateway has already done the expensive part — it holds
a string the user sent — and it is going to ask another service to tell it something that
string could have carried in the first place.

### A long-lived JWT, and nothing else

Fix the hop: put the claims in the token, sign it, let the Gateway verify locally. No
lookup, no network, no dependency. Give it a long life so nobody has to log in again.

This breaks on the second problem, completely. **A signed token is valid until it expires,
and nothing can stop it.** There is no list to remove it from; the signature is the whole
check, and it keeps verifying. A 30-day JWT that leaks is 30 days of access to that account,
and the person it belongs to cannot do anything about it — not by changing their password,
not by clicking "log out everywhere", because neither touches a token the server never
consults.

The usual patch is a revocation list the Gateway checks. That is a lookup on every request,
which is the previous option wearing a JWT.

### A short-lived JWT, and nothing else

Keep the local verification, cut the lifetime to fifteen minutes. Now a leak is fifteen
minutes of damage.

It works, and it is unusable. The user logs in again every fifteen minutes, forever. The
whole point of logging in once was to not do that.

## The split

Two tokens, because there are two jobs and no single token does both well.

| | Access token | Refresh token |
|---|---|---|
| Form | Signed JWT | 32 random bytes, base64url |
| Says anything? | Yes — account id, session id, expiry | Nothing. It is a lookup key |
| Lifetime | 15 minutes | Until exchanged — at most 30 days from login |
| Checked how? | Signature, locally, no network | Row in `identity.refresh_tokens` |
| Sent when? | Every authenticated request | Only to `/v1/auth/refresh` |
| Revocable? | **No** | Yes — one `UPDATE` on its session |
| Stored where? | Nowhere. It is self-contained | Only its **hash** |

The access token is checked constantly and never revoked. The refresh token is revocable and
almost never checked — once every fifteen minutes per client, against ~1,700 timeline reads
a second in the same period. The expensive property is attached to the rare operation, and
the cheap property to the constant one.

A worked comparison. One client, active for an hour:

- **Session-lookup design:** ~240 timeline reads, each a lookup in Identity. 240 hops.
- **This design:** ~240 timeline reads, each verified locally with an HMAC. **4** calls to
  Identity — one refresh per fifteen minutes. A 60× reduction, and Identity being down for
  ten of those minutes is invisible to a reader.

## What is inside the access token

```text
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxODQ3MTAwMDAwMDAxIiwic2lkIjoi…
└──────────── header ───────────┘ └──────────────── payload ────────────────┘ └ signature ┘
```

Three base64url segments joined by dots, the third an HMAC-SHA256 of the first two. That is
the entire format.

```jsonc
// header
{ "alg": "HS256", "typ": "JWT" }

// payload
{
  "sub": "1847100000001",   // the account — a Snowflake, as a string
  "sid": "1847362819999",   // the session this login opened
  "iat": 1789128000,        // seconds since the epoch, not milliseconds
  "exp": 1789128900         // iat + 900
}
```

Three details that are easy to get wrong and silent when you do.

**`iat` and `exp` are in seconds.** RFC 7519 calls this `NumericDate`. Milliseconds there
produce a token that expires in roughly the year 58,000 — and every verifier on earth accepts
it, because it is a perfectly well-formed future timestamp. Nothing warns you.

**`sub` is a string.** A Snowflake is 64 bits, and `Number.MAX_SAFE_INTEGER` is 2^53−1. As a
JSON number it is silently truncated by every JavaScript client that parses it —
see [[snowflake-ids]].

**`sid` is there for a revocation check that does not exist yet.** Nothing reads it today.
It scopes the token to one login rather than to the account, which is what will let a
future check ask "was *this* session revoked?" rather than signing out every device. A claim
added later would be absent from every token already in circulation, so it goes in now.

### Why the signing is hand-written

`node:crypto`, about forty lines, in
[`hs256-access-token-issuer.ts`](../../backend/services/identity/src/infrastructure/security/hs256-access-token-issuer.ts).

The modern default is [`jose`](https://github.com/panva/jose), and it was ruled out on a
mechanical ground rather than a philosophical one: it is ESM-only from v6, and every service
here compiles to CommonJS ([`tsconfig.base.json`](../../tsconfig.base.json) says why). Using
it would mean a dynamic `await import()` in one adapter — an exception to a rule the rest of
the repository keeps.

**This has a real cost, and it is not symmetric.** Signing is the easy half: concatenate,
HMAC, encode. Verification is where JWT's failure modes live, and they are notorious:

- **`alg: none`** — a verifier that trusts the token's own header will accept a token with no
  signature at all.
- **Algorithm confusion** — a verifier that accepts both RS256 and HS256 can be handed an
  HS256 token signed with the *public* RSA key it was going to verify against.
- **Non-constant-time comparison** — comparing signatures with `===` leaks, byte by byte,
  how much of a forged signature was right.

All three are avoidable, and all three have to be avoided deliberately. That code lands in
the Gateway with [#7](https://github.com/samueldamatta/X-clone/issues/7). If this were a
system with real users rather than a project built to be understood, the library would be
the right call.

## Why HS256 and not a key pair

One shared secret, in `JWT_SECRET`, held by both Identity and the Gateway.

**The cost, stated plainly: whoever can verify can also mint.** The Gateway only needs to
check signatures, but with a shared secret it holds everything needed to forge a token for
any account in the system. Compromise the Gateway and you have not just leaked traffic —
you have an account-minting machine.

An asymmetric algorithm (EdDSA, RS256) removes that: Identity holds the private key and
signs, the Gateway holds only the public key and can verify but not forge. The reason it is
not here is key distribution — either a JWKS endpoint for the Gateway to fetch from (another
endpoint, another cache, another failure mode) or a second environment variable that someone
has to keep in step with the first. Worth revisiting when a third service needs to verify,
because at that point the shared secret is in three places and the argument has changed.

## Why the refresh token is hashed with SHA-256 and not argon2id

The password next door gets argon2id. The refresh token, sitting in the same schema and
also a secret, gets a plain SHA-256. That looks like an inconsistency and is not.

Argon2 is **deliberately slow**, and slowness is a defence against *guessing*. A human
password has maybe 30 bits of entropy — it is in a dictionary, or close to a word in one —
so an attacker with the hashes can try candidates. Making each attempt cost 100ms and 64MB
of memory turns "a billion guesses an hour" into "ten thousand", and that is what makes the
hash worth stealing but not worth cracking.

A refresh token is **32 bytes from a CSPRNG**. 2^256 possibilities, no dictionary, no
structure, nothing correlated with anything. There is no guessing attack to slow down.
Argon2 here would buy nothing at all, and it would be paid on the refresh path — which
[#8](https://github.com/samueldamatta/X-clone/issues/8) puts on every client every fifteen
minutes.

The rule underneath: **slow hashing defends low-entropy secrets. High-entropy secrets need
only that the stored form not be reversible.** SHA-256 gives that.

What hashing buys, in both cases, is the same: a dump of `identity.sessions` is a list of
digests. It does not let the reader log in as anybody.

## Why a failed login says nothing

An unknown handle and a wrong password produce **the same status, the same body, and the
same response time.**

The reason is account enumeration. If "no such user" and "wrong password" are
distinguishable, the login endpoint answers a different question than the one it was built
for: *does this handle exist?* Run a list of handles through it and you have a roster of
real accounts — worth having on its own, and worth much more as the input to a credential
stuffing run against a breach dump.

So the response carries no `field` member, and one fixed message. But content is only half.

### The half that is easy to miss

Verifying a password costs an argon2id hash, which is slow **on purpose** — that is the
entire point of the algorithm. An unknown handle has no hash to verify against, so the
obvious implementation returns immediately.

Measured against the running containers, on this project's code:

| Path | Median response |
|---|---|
| Wrong password | 28.8 ms |
| Unknown handle | 29.3 ms |
| Valid login | 30.0 ms |
| **A request rejected before any hashing** | **1.4 ms** |

The last row is the counterfactual that gives the others meaning. A path that skips the hash
answers in about a twentieth of the time. If the unknown-handle branch returned early, it
would sit down there at 1–3ms while a wrong password sat at 29 — and **a 20× timing gap is a
perfectly good answer to "does this handle exist?"** for anyone willing to run a stopwatch.
Identical bodies would have hidden nothing.

The fix is one line in
[`login.use-case.ts`](../../backend/services/identity/src/application/login.use-case.ts):

```ts
if (credentials === undefined) {
  // A hash whose result is thrown away.
  await this.hasher.hash(input.password);
  throw new InvalidCredentialsError();
}
```

`hash` rather than a verify against some hard-coded dummy digest, for two reasons: argon2's
hash and verify do the same work with the same parameters, so the cost provably matches; and
there is no constant to drift out of step the day the hasher's settings change.

This also explains something the [API contract](../04-api-contracts.md) does otherwise
inconsistently: login is the one endpoint that **does not validate its input**. Register
rejects a two-character handle with a 400 naming the field. Login does not, because a 400
for "handle too short" beside a 401 for "handle unknown" restores exactly the distinction
everything above removes. A handle too short to register is simply a handle nobody has.

## A refresh token works once

The split above leaves one hole. The refresh token lives 30 days, is revocable, and is
almost never checked — so a stolen one is 30 days of fresh access tokens for whoever holds
it, and the person it belongs to has no way to know. Revocability only helps if someone
knows there is something to revoke.

**Rotation** closes it. `POST /v1/auth/refresh` does not just hand out a new access token:
it hands out a new refresh token too, and marks the one presented as **spent**. A refresh
token is good for exactly one exchange.

A worked example. Sam logs in on a laptop and gets `A`. Fifteen minutes later the laptop
refreshes:

```text
login            → A
refresh(A)       → B      A is spent
refresh(B)       → C      B is spent
refresh(A)       → 401    ← somebody is holding a copy of A
```

The last line is the point. Nobody honest presents `A` after it was exchanged — the laptop
threw it away the moment it received `B`. So a spent token arriving is not a mistake to
reject quietly; it is **evidence that the token was copied**.

### Reuse detection: why the whole chain dies

What the server knows at that moment is only that two parties held `A`. It does not know
which of them is the thief:

- If the thief used `A` first, *they* hold the live token now, and the laptop is the one
  arriving with a spent `A`.
- If the laptop refreshed first, the thief is the one arriving with a spent `A`.

Rejecting just the presented token would be right in the second case and would leave the
thief logged in forever in the first. So the response to a replay is to revoke **every
token in the chain** — `A`, `B`, `C`, and whatever is newest — by revoking the session they
belong to. Both parties are signed out. The legitimate one logs in again with a password
the thief does not have; the thief has nothing left.

That is a real cost to an innocent user, paid deliberately: being asked to log in again is
the correct outcome when a credential has demonstrably leaked. And it is scoped. The chain
is one login; the same account's phone, which logged in separately, is untouched.

### Where the chain lives

`identity.sessions` held one `refresh_token_hash` per login. There were three ways to
make it hold a chain.

**Overwrite the hash on each rotation.** One `UPDATE`, no new table — and it makes reuse
detection impossible. After `refresh(A)` the row holds `hash(B)`; `hash(A)` is gone. When
the copy of `A` arrives, the lookup finds nothing, and "this token was already spent" is
indistinguishable from "this token never existed". The replay is rejected, and nobody
learns that it happened.

**A new `sessions` row per rotation, linked by a parent id.** Keeps history, but the
session id changes every fifteen minutes — and the session id is the access token's `sid`
claim, which exists so that #9's logout can revoke *this login*. A login whose identity
changes four times an hour is not something logout can point at.

**A separate `refresh_tokens` table.** What was built:

```sql
CREATE TABLE refresh_tokens (
  id          BIGINT PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES sessions(id),
  token_hash  TEXT NOT NULL UNIQUE,   -- the lookup, and never the token itself
  spent_at    TIMESTAMPTZ,            -- null until exchanged; never deleted
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The session is the chain; its id never changes. Each token is a row pointing at it.
Revoking the chain is one `UPDATE sessions SET revoked_at = now()`, and every token in it —
the newest included — is dead at once, because a refresh checks its session before it
checks anything else. The cost is a table that gains a row every fifteen minutes per active
client and never loses one.

### Two tabs, one token

Two browser tabs share one refresh token, and both notice the access token expired at the
same moment. This is the normal case, not an edge one.

The naive implementation reads the row, sees `spent_at IS NULL`, and writes. Two requests
interleaved like that both read "unspent", both write, and both return a new token. The
chain has **forked**: two live tokens, and a thief who wins that race holds a branch that
no replay will ever expose, because nothing they present is ever spent.

The guard is that the write carries its own condition:

```sql
UPDATE refresh_tokens SET spent_at = now()
 WHERE id = $1
   AND spent_at IS NULL
RETURNING id;
```

Two concurrent `UPDATE`s of one row serialise on its row lock. The second waits for the
first to commit, and Postgres then re-checks its `WHERE` against the row as it now is —
`spent_at` is no longer null, so it matches nothing and returns zero rows. The new token is
only inserted, in the same transaction, when a row came back.

Measured against the real database, not reasoned about: **20 concurrent rotations of one
token, one winner**, and the chain holds exactly two rows. With `spent_at IS NULL` removed
from that `WHERE`, the same run gives **20 winners and 21 live tokens**.

And the loser? By the rule above it presented a spent token, so it is a replay, and the
chain is revoked. **Two tabs refreshing at the same instant sign the person out.** A grace
period — "spent less than two seconds ago, reject without revoking" — would avoid that, and
was rejected: it is a window in which a replay goes undetected, and it contradicts the one
rule that makes detection work. The price moves to the client instead: the frontend in
Phase 5 has to make refreshes single-flight across tabs (`navigator.locks` or a
`BroadcastChannel`), so that one tab refreshes and the others wait for its result.

The session needs the same care, and the obvious way of checking it is not enough. A
first version put `AND EXISTS (SELECT 1 FROM sessions … revoked_at IS NULL)` in that
`UPDATE`. Postgres's re-check after a lock wait covers the row being updated, not rows a
subquery read — so a revocation committing *during* a rotation went unseen, and the
rotation minted a fresh token into a session that had just been revoked. Reproduced against
the real database with a revocation held open mid-transaction: the rotation raced past it,
and the chain gained a row.

The fix is a locking read first, in the same transaction:

```sql
SELECT id FROM sessions WHERE id = $1 AND revoked_at IS NULL FOR SHARE;
```

Under `READ COMMITTED`, a locking read waits for a concurrent `UPDATE` of that row to
finish and then sees its committed result. So a rotation that overlaps a revocation waits
for it and loses; a revocation that arrives during a rotation waits for the rotation to
commit, and then kills the token it just minted. Either way the two are ordered, and
nothing slips between them. It costs one more statement on every refresh.

### Absolute expiry

A rotated token inherits its session's `expires_at`. It does not get 30 fresh days. Sam is
asked for a password 30 days after logging in, however active they have been.

Sliding expiry — each rotation extends the deadline — is what consumer apps usually do, and
it is what Sam would notice first. It was rejected for what it does to a stolen chain on a
device its owner stopped using: nothing ever presents a spent token, so nothing is detected,
and every rotation extends the thief's access forever. Absolute expiry bounds that at 30
days. It also means the deadline lives in one column on `sessions` instead of one per token.

### What the client sees

Every rejected refresh — unknown, spent, expired, revoked — is the same `401`, byte for
byte, with no `detail` and no `field`. The client does not need to know which: its next
move is "log in again" in all four cases. A thief learns nothing from it either, including
whether their copy was the one that got caught.

What the client *must* tell apart is a `401` from a transient failure. Identity being down
is a `503` or `504`, and the right response to that is to try again later — not to throw
the person out. A client that treats every refresh failure as "logged out" signs everyone
out during an outage; one that retries every failure hammers the endpoint forever with a
token that will never work again.

### Over-engineered, honestly

At this project's scale — one developer, one laptop — nobody is stealing refresh tokens.
Rotation costs a row per refresh, a transaction instead of a read, and a frontend that has
to coordinate its tabs. It is here because it is the mechanism: a credential designed so
that using a stolen copy is also how the theft is discovered.

## What it costs

**A stolen access token works until it expires, and nothing can stop it.** Fifteen minutes
is not a guess — it *is* the damage window, chosen to be short enough to survive and long
enough that refreshing is not constant. Changing the password does not shorten it. Logging
out does not shorten it. This is the price of local verification, paid knowingly.

**Fifteen minutes is not free either.** Every client calls `/v1/auth/refresh` four times an
hour. That traffic did not exist under session cookies, and it is why rotation had to be
correct under concurrency — see **Two tabs, one token** above.

**Two things to carry now instead of one.** Every client stores, sends and renews two
credentials with different rules. The frontend in Phase 5 has to get this right, and
"refresh on 401, retry once, and do not stampede when six requests fail at the same moment"
is real work.

**The tokens come back in a JSON body.** For a browser, an `httpOnly` cookie would put the
refresh token out of reach of XSS — a genuine advantage this design gives up. Taking it
means a cookie-shaped API every non-browser client has to work around, plus CSRF protection.
Deliberately deferred to Phase 5, when there is a real browser to decide for.

**Nothing is ever deleted.** Reuse detection needs to tell "this token never existed" from
"this token was already spent", and a deleted row cannot. `sessions` grows by one row per
login. `refresh_tokens` grows much faster: four rows an hour per active client, so a device
left open for a session's whole 30 days writes 4 × 24 × 30 = **2,880** rows, of which one is
live. The partial index on `sessions` keeps revoked logins out of the way, and the lookup by
`token_hash` is a unique index, so neither gets slower — but both tables grow without bound
and will eventually want a reaper for chains whose session expired.

## Where to read it

1. [`login.use-case.ts`](../../backend/services/identity/src/application/login.use-case.ts) —
   the whole story in fifty lines
2. [`hs256-access-token-issuer.ts`](../../backend/services/identity/src/infrastructure/security/hs256-access-token-issuer.ts) —
   a JWT, written out
3. [`random-refresh-token-factory.ts`](../../backend/services/identity/src/infrastructure/security/random-refresh-token-factory.ts) —
   32 bytes and a digest
4. [`refresh-session.use-case.ts`](../../backend/services/identity/src/application/refresh-session.use-case.ts) —
   rotation and reuse detection, in the order the checks happen
5. [`drizzle-session.repository.ts`](../../backend/services/identity/src/infrastructure/persistence/drizzle-session.repository.ts) —
   the locking read and the conditional `UPDATE` that give every race one order
6. [`schema.ts`](../../backend/services/identity/src/infrastructure/persistence/schema.ts) —
   a session and its chain, as tables
7. [`scripts/integration.sh`](../../scripts/integration.sh) — all of the above, asserted
   against real containers, including two concurrent refreshes of one token

## See also

- [[internal-grpc]] — why the Gateway reaches Identity over protobuf rather than REST
- [[snowflake-ids]] — why `sub` is a string
- [`03-data-model.md`](../03-data-model.md) — the `sessions` and `refresh_tokens` tables
- [`04-api-contracts.md`](../04-api-contracts.md) — the public shape of `/v1/auth/login` and
  `/v1/auth/refresh`
