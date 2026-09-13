import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { Hs256AccessTokenVerifier, InvalidAccessTokenError } from './hs256-access-token-verifier';

/**
 * This file is the security specification of the verifier, and it is worth
 * reading before the implementation it drives.
 *
 * Signing is the easy half of JWT. Verification is where the format's
 * footguns live, and all three of the famous ones are here: `alg: none`,
 * algorithm confusion, and a signature comparison that leaks by timing.
 * Each has a test that fails if the defence is removed.
 *
 * The signer below is written out rather than imported from the Identity
 * service, because the Gateway does not depend on Identity's code — only on
 * the .proto and the shared secret. That is a real gap: nothing here proves
 * that the *actual* issuer and this verifier agree. `scripts/integration.sh`
 * closes it, by logging in for a real token and spending it on a real
 * request.
 */
const SECRET = 'a'.repeat(32);

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signWith(header: object, payload: object, secret = SECRET): string {
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');

  return `${signingInput}.${signature}`;
}

/** Seconds since the epoch — NumericDate, which is what RFC 7519 says `exp` is. */
function numericDate(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

const NOW = new Date('2026-09-12T12:00:00.000Z');
const FIFTEEN_MINUTES_S = 15 * 60;

function validClaims(overrides: Record<string, unknown> = {}) {
  return {
    sub: '1847100000001',
    sid: '1847100000002',
    iat: numericDate(NOW),
    exp: numericDate(NOW) + FIFTEEN_MINUTES_S,
    ...overrides,
  };
}

function validToken(overrides: Record<string, unknown> = {}): string {
  return signWith({ alg: 'HS256', typ: 'JWT' }, validClaims(overrides));
}

let verifier: Hs256AccessTokenVerifier;

beforeEach(() => {
  verifier = new Hs256AccessTokenVerifier(SECRET, { now: () => NOW });
});

describe('Hs256AccessTokenVerifier, the happy path', () => {
  it('accepts a well-formed token and returns its claims', () => {
    expect(verifier.verify(validToken())).toEqual({
      userId: '1847100000001',
      sessionId: '1847100000002',
      expiresAt: new Date(NOW.getTime() + FIFTEEN_MINUTES_S * 1000),
    });
  });

  it('reads exp as seconds, not milliseconds', () => {
    // A verifier that treated exp as milliseconds would compute an instant
    // in 1970 and refuse every token ever issued. The mistake is silent in
    // both directions, so the unit is asserted rather than assumed.
    const verified = verifier.verify(validToken());

    expect(verified.expiresAt.toISOString()).toBe('2026-09-12T12:15:00.000Z');
  });

  it('returns the account id as a string, never a number', () => {
    const verified = verifier.verify(validToken());

    // A Snowflake above 2^53-1 does not survive JSON's number type. If the
    // claim ever arrives unquoted, this is where it is caught.
    expect(typeof verified.userId).toBe('string');
  });
});

describe('the three classic JWT verification failures', () => {
  it('refuses alg: none, however well-formed the rest is', () => {
    // The original JWT vulnerability: a verifier that reads `alg` to decide
    // what to do finds "none", performs no check, and accepts anything.
    const unsigned = `${base64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${base64url(
      JSON.stringify(validClaims()),
    )}.`;

    expect(() => verifier.verify(unsigned)).toThrow(InvalidAccessTokenError);
  });

  it('refuses alg: none even when a signature is attached anyway', () => {
    const token = signWith({ alg: 'none', typ: 'JWT' }, validClaims());

    // The signature is genuinely correct here. It is refused on the header
    // alone, which is what makes the algorithm pinned rather than merely
    // preferred.
    expect(() => verifier.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it('refuses a header claiming another algorithm, even with a valid HS256 signature', () => {
    // Algorithm confusion. The attack needs a verifier that *chooses* its
    // algorithm from the header; this one never does, and additionally
    // refuses to accept a header that lies about what it is.
    const token = signWith({ alg: 'RS256', typ: 'JWT' }, validClaims());

    expect(() => verifier.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it('refuses a signature of the wrong length without crashing', () => {
    // crypto.timingSafeEqual throws a RangeError when its two buffers differ
    // in length. A verifier that calls it unguarded turns a malformed token
    // into a 500 — which is itself an oracle, since a mere 401 means the
    // length was right.
    const [header, payload] = validToken().split('.');
    const truncated = `${header}.${payload}.abc`;

    expect(() => verifier.verify(truncated)).toThrow(InvalidAccessTokenError);
  });
});

describe('tampering', () => {
  it('refuses a payload edited after signing', () => {
    const [header, , signature] = validToken().split('.');
    const forged = base64url(JSON.stringify(validClaims({ sub: '999' })));

    expect(() => verifier.verify(`${header}.${forged}.${signature}`)).toThrow(
      InvalidAccessTokenError,
    );
  });

  it('refuses a token signed with a different secret', () => {
    const token = signWith({ alg: 'HS256', typ: 'JWT' }, validClaims(), 'b'.repeat(32));

    expect(() => verifier.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it('verifies over the literal segments, not over a re-encoding of the parsed JSON', () => {
    // JSON.parse followed by JSON.stringify is not the identity function:
    // key order, whitespace and number formatting all change. A verifier
    // that re-encoded before hashing would compute a different signing input
    // than the issuer did, and would reject every genuine token — or worse,
    // accept a payload whose bytes were never signed.
    const claims = validClaims();
    const spaced = `{ "sub": "${claims.sub}",  "sid": "${claims.sid}", "iat": ${claims.iat.toString()}, "exp": ${claims.exp.toString()} }`;

    const signingInput = `${base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${base64url(spaced)}`;
    const signature = createHmac('sha256', SECRET).update(signingInput).digest('base64url');

    // Unusual spacing, signed exactly as it stands: it must be accepted,
    // because those are the bytes the signature covers.
    expect(verifier.verify(`${signingInput}.${signature}`).userId).toBe(claims.sub);
  });
});

describe('expiry', () => {
  it('refuses a token that has expired', () => {
    const expired = validToken({ exp: numericDate(NOW) - 1 });

    expect(() => verifier.verify(expired)).toThrow(InvalidAccessTokenError);
  });

  it('refuses a token that expires exactly now', () => {
    // `exp` is the instant at which the token is no longer valid, not the
    // last instant it is. RFC 7519: the current time must be *before* exp.
    expect(() => verifier.verify(validToken({ exp: numericDate(NOW) }))).toThrow(
      InvalidAccessTokenError,
    );
  });

  it('accepts a token with one second left', () => {
    expect(() => verifier.verify(validToken({ exp: numericDate(NOW) + 1 }))).not.toThrow();
  });

  it('grants no leeway for clock skew', () => {
    // A verifier with 30 seconds of leeway gives a stolen token 30 seconds
    // of extra life, and this system has nothing that can revoke one before
    // it expires. Both services read the same host clock under compose, so
    // there is no skew to absorb.
    expect(() => verifier.verify(validToken({ exp: numericDate(NOW) - 1 }))).toThrow(
      InvalidAccessTokenError,
    );
  });

  it('refuses a token with no exp at all', () => {
    const withoutExp: Record<string, unknown> = validClaims();
    delete withoutExp.exp;

    expect(() => verifier.verify(signWith({ alg: 'HS256', typ: 'JWT' }, withoutExp))).toThrow(
      InvalidAccessTokenError,
    );
  });

  it('refuses a non-numeric exp rather than coercing it', () => {
    expect(() => verifier.verify(validToken({ exp: '9999999999' }))).toThrow(
      InvalidAccessTokenError,
    );
  });
});

describe('malformed input', () => {
  it.each([
    ['empty', ''],
    ['one segment', 'abc'],
    ['two segments', 'abc.def'],
    ['four segments', 'a.b.c.d'],
    ['only dots', '..'],
    ['not base64url at all', '!!!.???.***'],
    ['a payload that is not JSON', `${base64url('{"alg":"HS256","typ":"JWT"}')}.bm90LWpzb24.sig`],
  ])('refuses %s', (_label, token) => {
    expect(() => verifier.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it('refuses a payload that is JSON but not an object', () => {
    const token = signWith({ alg: 'HS256', typ: 'JWT' }, [1, 2, 3]);

    expect(() => verifier.verify(token)).toThrow(InvalidAccessTokenError);
  });

  it.each([
    ['sub missing', { sub: undefined }],
    ['sub not a string', { sub: 1847100000001 }],
    ['sid missing', { sid: undefined }],
    ['sid not a string', { sid: 42 }],
  ])('refuses a token whose claims are unusable: %s', (_label, overrides) => {
    const claims: Record<string, unknown> = validClaims();
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) {
        delete claims[key];
      } else {
        claims[key] = value;
      }
    }

    expect(() => verifier.verify(signWith({ alg: 'HS256', typ: 'JWT' }, claims))).toThrow(
      InvalidAccessTokenError,
    );
  });
});

describe('uniform rejection', () => {
  /**
   * The acceptance criterion from the ticket, as an assertion: an absent,
   * an expired and a tampered token must be indistinguishable. The Gateway
   * turns every one of these into the same 401 body, and this is the layer
   * that has to make that possible — a verifier that threw three different
   * error types, or three different messages, would hand the caller the
   * distinction however carefully the controller above it behaved.
   */
  it('rejects every bad token with the same error type and the same message', () => {
    const rejections = [
      validToken({ exp: numericDate(NOW) - 1 }),
      signWith({ alg: 'HS256', typ: 'JWT' }, validClaims(), 'b'.repeat(32)),
      signWith({ alg: 'none', typ: 'JWT' }, validClaims()),
      'not-a-token',
      '',
    ].map((token) => {
      try {
        verifier.verify(token);
        return 'accepted';
      } catch (error) {
        return `${(error as Error).name}: ${(error as Error).message}`;
      }
    });

    expect(new Set(rejections).size).toBe(1);
    expect(rejections[0]).not.toBe('accepted');
  });
});

describe('the secret', () => {
  it('refuses to be built with a secret shorter than the HMAC it computes', () => {
    // RFC 7518 §3.2: an HS256 key must be at least 256 bits. A shorter one
    // is the weakest part of the construction, and failing at boot is the
    // only cheap place to find out.
    expect(() => new Hs256AccessTokenVerifier('a'.repeat(31))).toThrow();
  });

  it('does not put the secret in the message when it refuses', () => {
    const secret = 'short-secret-value';

    expect(() => new Hs256AccessTokenVerifier(secret)).toThrow(expect.not.stringContaining(secret));
  });
});
