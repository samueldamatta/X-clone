import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * What the Gateway learns about a caller from their token, and the only
 * thing it learns — there is no lookup behind this. Verification is local
 * arithmetic over the token's own bytes, which is the entire reason the
 * access token is a JWT and not an opaque string.
 *
 * The price of that is stated plainly, because it is the central trade of
 * this design: nothing can revoke a token before it expires. A logout marks
 * the *session* revoked, and the refresh token that belongs to it stops
 * working immediately — but the access token already in the thief's hands
 * keeps working for up to fifteen minutes, because no request goes anywhere
 * that could be told otherwise. The alternative is a network hop on every
 * authenticated request, which is the thing being bought here.
 *
 * `sessionId` is what makes the other design reachable later: a revocation
 * check against a Redis set of dead sessions would key on it, and it is
 * already in every token in circulation.
 */
export interface VerifiedAccessToken {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

/**
 * One error for every way a token can fail, on purpose.
 *
 * Absent, expired, tampered, signed with the wrong key, structurally
 * nonsense — all of them raise this, with this message. The acceptance
 * criterion says the rejections must be indistinguishable, and the only
 * reliable way to get that is to never produce the distinction in the first
 * place. A controller that carefully flattened three error types into one
 * response would still be one `console.error` away from leaking which.
 *
 * Why it matters: "expired" tells an attacker the signature was *valid*,
 * which tells them the token they stole is genuine and that the clock, not
 * the key, is what stopped them. That is a meaningfully different next move
 * from "your forgery was wrong".
 */
export class InvalidAccessTokenError extends Error {
  constructor() {
    super('the access token is not valid');
    this.name = 'InvalidAccessTokenError';
  }
}

/**
 * HS256's MAC is 256 bits, and RFC 7518 §3.2 requires a key at least as
 * long as the hash it feeds. Same constant, same reasoning, as the issuer
 * on Identity's side.
 */
export const MIN_SECRET_BYTES = 32;

export interface VerifierClock {
  now(): Date;
}

const JWT_SEGMENTS = 3;

/**
 * Pinned, and never read from the token.
 *
 * The single most exploited mistake in JWT's history is a verifier that
 * takes its algorithm from the header — a field the attacker writes. Two
 * attacks follow from it: `alg: none`, where the verifier is told to check
 * nothing and obliges, and algorithm confusion, where a token claiming
 * RS256 is verified with an RSA *public* key used as an HMAC secret, which
 * the attacker also knows.
 *
 * This verifier computes HMAC-SHA256 unconditionally. The header is then
 * checked to match, which is belt and braces: even if that check were
 * deleted, `alg: none` would still fail, because a signature would still
 * have to be right.
 */
const EXPECTED_ALGORITHM = 'HS256';
const EXPECTED_TYPE = 'JWT';

const systemClock: VerifierClock = { now: () => new Date() };

export class Hs256AccessTokenVerifier {
  private readonly secret: Buffer;

  constructor(
    secret: string,
    private readonly clock: VerifierClock = systemClock,
  ) {
    const key = Buffer.from(secret, 'utf8');
    if (key.byteLength < MIN_SECRET_BYTES) {
      // The length, never the value. This message reaches logs.
      throw new Error(
        `the JWT secret must be at least ${MIN_SECRET_BYTES.toString()} bytes, got ${key.byteLength.toString()}.`,
      );
    }
    this.secret = key;
  }

  /**
   * Throws InvalidAccessTokenError for anything that is not a live, genuine
   * token. It never returns a "reason" — see the error's own comment.
   */
  verify(token: string): VerifiedAccessToken {
    const segments = token.split('.');
    if (segments.length !== JWT_SEGMENTS) {
      throw new InvalidAccessTokenError();
    }

    const [encodedHeader, encodedPayload, signature] = segments as [string, string, string];

    /**
     * The signature is checked first, and it is checked over the literal
     * text of the first two segments — not over anything re-encoded from
     * parsed JSON.
     *
     * This ordering is the discipline that makes the rest safe. Everything
     * decoded below has, by that point, been proven to be bytes this system
     * signed; parsing before verifying would mean running a JSON parser over
     * attacker-chosen input and then making decisions from the result.
     *
     * And it must be the literal text: `JSON.parse` then `JSON.stringify`
     * changes key order, whitespace and number formatting, so re-encoding
     * would hash a different string than the issuer signed.
     */
    if (!this.signatureMatches(`${encodedHeader}.${encodedPayload}`, signature)) {
      throw new InvalidAccessTokenError();
    }

    const header = decodeJsonObject(encodedHeader);
    if (header.alg !== EXPECTED_ALGORITHM || header.typ !== EXPECTED_TYPE) {
      throw new InvalidAccessTokenError();
    }

    return this.readClaims(decodeJsonObject(encodedPayload));
  }

  private signatureMatches(signingInput: string, signature: string): boolean {
    const expected = createHmac('sha256', this.secret).update(signingInput).digest('base64url');

    /**
     * Compared as base64url *text* rather than as decoded bytes. Node's
     * base64 decoding is lenient — it skips characters it does not
     * recognise — so two different strings can decode to the same buffer,
     * and a comparison of the decoded form would accept a signature that is
     * not the one that was issued.
     */
    const presented = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    /**
     * The length check is not an optimisation; timingSafeEqual throws a
     * RangeError on mismatched lengths. Calling it unguarded turns a
     * malformed token into a 500, and a 500 that only happens for the wrong
     * *length* is itself an oracle.
     *
     * Comparing lengths first does leak the length of the signature — which
     * is fixed, public, and the same for every HS256 token ever issued.
     */
    if (presented.byteLength !== computed.byteLength) {
      return false;
    }

    /**
     * And this is why the whole function exists. `presented === computed`
     * stops at the first differing byte, so the time it takes says how many
     * leading bytes were right. An attacker with enough samples walks the
     * signature out one byte at a time — 32 × 256 guesses instead of 2^256.
     * The defence is real even though no test here can prove it: timing is
     * not observable from inside the process measuring it.
     */
    return timingSafeEqual(presented, computed);
  }

  private readClaims(payload: Record<string, unknown>): VerifiedAccessToken {
    const { sub, sid, exp } = payload;

    /**
     * `typeof sub === 'string'`, not a truthy check, and not a cast. A
     * Snowflake crosses every boundary in this system as a string because
     * 64 bits do not survive JSON's number type; a token carrying `sub` as
     * a number is either from a broken issuer or from an attacker, and
     * either way it is not something to coerce and carry on with.
     */
    if (typeof sub !== 'string' || typeof sid !== 'string' || typeof exp !== 'number') {
      throw new InvalidAccessTokenError();
    }

    // NumericDate is *seconds* since the epoch. Reading it as milliseconds
    // puts every expiry in 1970 and refuses every token; writing it as
    // milliseconds puts them in the year 56000 and refuses none. The
    // mistake is silent in both directions.
    const expiresAt = new Date(exp * 1000);

    /**
     * Strictly before, with no leeway. RFC 7519 says the current time must
     * be before `exp`, so a token expiring exactly now is already dead.
     *
     * Leeway for clock skew is the usual thing to add here and is not added:
     * every second of it is a second of extra life for a stolen token, and
     * nothing in this system can revoke one early. Both services read the
     * same host clock under compose, so there is no skew to absorb.
     */
    if (this.clock.now().getTime() >= expiresAt.getTime()) {
      throw new InvalidAccessTokenError();
    }

    return { userId: sub, sessionId: sid, expiresAt };
  }
}

/**
 * Decodes one base64url segment and insists the result is a JSON object.
 *
 * Arrays and bare primitives are valid JSON and are refused: `payload.sub`
 * on an array is undefined, which would fall through to the claim checks
 * and fail there anyway — but relying on that is relying on a coincidence,
 * and the next claim added might not be so lucky.
 */
function decodeJsonObject(segment: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    // The parser's message quotes the input it choked on. That input is a
    // token, so it goes nowhere.
    throw new InvalidAccessTokenError();
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidAccessTokenError();
  }

  return parsed as Record<string, unknown>;
}
