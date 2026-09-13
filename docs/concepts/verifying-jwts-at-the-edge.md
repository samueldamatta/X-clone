# Verifying JWTs at the edge

> **Scope.** [Access and refresh tokens](access-and-refresh-tokens.md) explains why login
> issues a signed JWT at all. This is the other half: what the Gateway does with one when it
> arrives, why that half is where the format's real dangers live, and what verifying locally
> costs. Written with [#7](https://github.com/samueldamatta/X-clone/issues/7), which added
> the first route that requires proof of identity.

## The problem

A request arrives at the Gateway carrying a string:

```
PATCH /v1/users/me
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI5MjQwMTUwNTE3…
```

Before anything else happens, the Gateway has to answer one question: **is this a token this
system issued, is it still alive, and whose is it?** It has to answer on every authenticated
request — 1,700 a second at peak, by the numbers in
[`02-capacity-estimation.md`](../02-capacity-estimation.md) — and it has to answer without
being wrong, because being wrong here means one account writing another's data.

The signing half of this is easy, and Identity already does it in about fifteen lines.
Verification is where JWT's reputation comes from.

## Why "just use the library" is the right answer, and why this repo does not

**In a production system, use an audited library.** `jose`, `jsonwebtoken`, whatever your
language's equivalent is. Everything below is a list of mistakes people have actually
shipped, and a library is a list of those mistakes already fixed by someone who has seen
them all.

This repository writes it out by hand for one reason: a verifier you have not written is a
verifier whose failure modes you do not know. The point of the project is understanding, and
"we call `jwt.verify` and it returns the claims" teaches nothing about why `jwt.verify` has
the parameters it has.

There is also a smaller, practical reason it was easy to decide:
[`hs256-access-token-issuer.ts`](../../backend/services/identity/src/infrastructure/security/hs256-access-token-issuer.ts)
already signs by hand, because `jose` is ESM-only from v6 and every service here compiles to
CommonJS. Having written one half, writing the other is consistent rather than novel.

## What a JWT actually is

Three base64url segments joined by dots:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 . eyJzdWIiOiI5MjQwMTUwNTE3NjM5MTY4MCIsImV4cCI6MTc4OTI1NjczNX0 . 4f0a…
└────────── header ──────────────────┘ └──────────── payload ────────────────────────────────────────┘ └ signature ┘
```

The header and payload are **not encrypted**. base64url is an encoding, not a cipher —
anyone holding the token can read every claim in it. The signature is an HMAC-SHA256 of the
literal text `header.payload`, computed with a secret only the services know.

That is the entire format. Which means verification is: recompute the HMAC, compare, then
look at `exp`.

Four ways to get those three steps wrong follow.

## Mistake 1: reading `alg` from the header

The header says which algorithm signed the token:

```json
{ "alg": "HS256", "typ": "JWT" }
```

The obvious implementation reads that field and verifies accordingly. **The header is
written by whoever sent the token.** An attacker edits it.

Set `"alg": "none"` — a real value in the JWT spec, meaning "unsecured" — strip the
signature, and a verifier that obeys the header performs no check at all and accepts a
payload the attacker wrote from scratch. This is the oldest JWT vulnerability there is, and
it shipped in most major libraries around 2015.

The subtler version is **algorithm confusion**. A system using RS256 verifies with a public
key, which is public. An attacker changes `alg` to `HS256` and signs the token using that
public key as the HMAC secret. A verifier that picks its algorithm from the header dutifully
runs HMAC-SHA256 with a key the attacker also has, and the signature matches.

The fix is not to validate the header more carefully. The fix is to **never read it**:

```ts
// Fixed, not read from the token. The verifier computes HMAC-SHA256
// because that is what this system issues, full stop.
if (!this.signatureMatches(`${encodedHeader}.${encodedPayload}`, signature)) {
  throw new InvalidAccessTokenError();
}
```

The header is then checked to *match* `HS256`, which is belt and braces: delete that check
and `alg: none` still fails, because a signature still has to be right.

## Mistake 2: comparing signatures with `===`

```ts
if (computed === presented) { … }   // wrong
```

String comparison stops at the first differing byte. A signature whose first byte is right
takes measurably longer to reject than one whose first byte is wrong — microseconds, but
measurable across enough samples.

An attacker who can time responses walks the signature out one byte at a time: try all 256
values for byte one, keep the slowest, move to byte two. That turns 2^256 guesses into
roughly 32 × 256 — about eight thousand. A number you can do over a weekend.

`crypto.timingSafeEqual` compares every byte regardless, so the time says nothing. It has
one sharp edge, and it is the reason the code has a length check in front of it:

```ts
// timingSafeEqual throws a RangeError on mismatched lengths. Calling it
// unguarded turns a malformed token into a 500 — and a 500 that only
// happens for the wrong length is itself an oracle.
if (presented.byteLength !== computed.byteLength) {
  return false;
}
```

Comparing lengths first does leak the signature's length, which is fixed, public, and
identical for every HS256 token ever issued.

This is the one defence in the file that **no test here can prove**. Timing is not
observable from inside the process doing the measuring. The tests prove the length guard
does not crash; the constant-time property rests on the comment and on `timingSafeEqual`
being what it says it is.

## Mistake 3: verifying a re-encoding instead of the original bytes

Tempting, and wrong:

```ts
const payload = JSON.parse(decode(segments[1]));       // parse first
const signingInput = encode(header) + '.' + encode(JSON.stringify(payload));
```

`JSON.parse` followed by `JSON.stringify` is **not** the identity function. Key order,
whitespace and number formatting all change. The re-encoded string is not the string the
issuer signed, so either every genuine token is rejected, or — if the verifier is lenient
somewhere else — a payload whose bytes were never signed gets accepted.

The signature covers the literal text of the first two segments. So the verifier hashes the
literal text, and **only decodes anything after the signature has matched**. Everything
parsed below that line has already been proven to be bytes this system produced. Parsing
first would mean running a JSON parser over attacker-chosen input and then making decisions
from the result.

## Mistake 4: getting `exp` wrong, in either direction

`exp` is a **NumericDate**: seconds since the epoch, not milliseconds. Both directions of
that mistake are silent:

| Mistake | Effect |
|---|---|
| Issuer writes milliseconds | Every token expires in the year 56000. Nothing ever rejects one. |
| Verifier reads milliseconds | Every expiry lands in 1970. Nothing is ever accepted. |

The second fails loudly on the first request. The first fails never, which is worse — so
both sides have a test that asserts the unit rather than the rough magnitude.

The comparison is strictly before, with **no leeway**:

```ts
if (this.clock.now().getTime() >= expiresAt.getTime()) {
  throw new InvalidAccessTokenError();
}
```

Adding thirty seconds of skew tolerance is the usual advice and is deliberately not taken
here. Every second of leeway is a second of extra life for a stolen token, and nothing in
this system can revoke one early. Both services read the same host clock under compose, so
there is no skew to absorb.

## Why every rejection is the same rejection

Absent, malformed, expired, tampered, signed with the wrong key: one error type, one
message, one 401, one body, byte for byte.

The temptation to be helpful is strong — "token expired" is a genuinely useful thing to tell
a client, and plenty of APIs do. Consider what it tells someone who is not a client.
"Expired" means the signature was **valid**. It says the token they stole is real, that the
key is not what stopped them, and that a fresher one from the same source would work. That
is a materially different next move from "your forgery was wrong".

The defence only works if the distinction is never produced in the first place. A controller
carefully flattening three error types into one response is one `console.error` away from
leaking which — so
[`InvalidAccessTokenError`](../../backend/gateway/src/infrastructure/security/hs256-access-token-verifier.ts)
carries no reason to flatten, and the guard catches it without inspecting it.

One deliberate exception to the silence: the 401 carries `WWW-Authenticate: Bearer`, because
RFC 7235 requires a 401 to say how to authenticate. It is bare. RFC 6750 defines
`error="invalid_token"` and `error="expired_token"` parameters for exactly this header, and
sending either would put the distinction straight back into the response.

## What this buys, and what it costs

**Buys:** an authenticated request costs one HMAC — microseconds — and no network hop. At
1,700 requests a second, the alternative is 1,700 extra calls a second into Identity, and it
makes Identity a hard dependency of reading a timeline.

That is not a claim; `scripts/integration.sh` stops the Identity container and checks two
things:

| With Identity stopped | Answer | What it proves |
|---|---|---|
| Request with a tampered token | `401` | The token was judged without leaving the Gateway |
| Request with a valid token | `504` | A passing token *does* go downstream — so the 401 was not just a broken Gateway |

Neither assertion means much alone. Together they say exactly one thing.

**Costs**, and both are real:

**1. Nothing can revoke an access token before it expires.** A logout marks the *session*
revoked and kills the refresh token immediately — but the access token already in a thief's
hands keeps working for up to fifteen minutes, because no request goes anywhere that could
be told otherwise. Fifteen minutes is the number that bounds the damage, and it is why the
access token's life is short. The `sid` claim is already in every token in circulation, so
the day this becomes unacceptable, a revocation check against a Redis set of dead sessions
has something to key on — at the price of the network hop this design exists to avoid.

**2. Whoever can verify can also mint.** HS256 is a shared secret: the Gateway holds the
same key Identity signs with, so a compromised Gateway can forge a token for any account.
Asymmetric keys (RS256, EdDSA) would prevent exactly that — Identity keeps the private half,
the Gateway gets a public one and can only check. The price is distributing that public key
and keeping it in step, via JWKS or a second environment variable. The day a third service
needs to verify is the day this stops being worth avoiding.

## Where to read it

1. [`hs256-access-token-verifier.test.ts`](../../backend/gateway/src/infrastructure/security/hs256-access-token-verifier.test.ts)
   — **start here.** It is the security specification; every mistake above has a test that
   fails if the defence is removed.
2. [`hs256-access-token-verifier.ts`](../../backend/gateway/src/infrastructure/security/hs256-access-token-verifier.ts)
   — the implementation those tests drove.
3. [`access-token.guard.ts`](../../backend/gateway/src/presentation/http/access-token.guard.ts)
   — the `Authorization` header, the uniform 401, and `@Principal()`.
4. [`hs256-access-token-issuer.ts`](../../backend/services/identity/src/infrastructure/security/hs256-access-token-issuer.ts)
   — the other side, for comparison.
