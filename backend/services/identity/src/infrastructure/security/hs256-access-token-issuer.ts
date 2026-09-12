import { createHmac } from 'node:crypto';
import type { AccessTokenClaims, AccessTokenIssuer } from '../../domain/ports/access-token-issuer';

/**
 * A JWT is three base64url segments joined by dots, the third being an HMAC
 * of the first two. That is the whole format, and it is written out here
 * rather than pulled from a library on purpose — see
 * docs/concepts/access-and-refresh-tokens.md.
 *
 * Why not `jose`, the modern default: it is ESM-only from v6, and every
 * service in this repo compiles to CommonJS (tsconfig.base.json says why).
 * Reaching it would mean a dynamic `await import()` in one adapter, an
 * exception to a rule the rest of the repo keeps.
 *
 * The honest cost of hand-rolling: signing is the easy half. Verification
 * is where JWT's footguns live — `alg: none`, algorithm confusion, a
 * non-constant-time signature comparison — and that half lands in the
 * Gateway with #7. It will be written explicitly, but it will be written
 * by us rather than by a library that has already been audited.
 */

/**
 * Fixed, not read from the claims. A JWT header is attacker-controlled
 * input on the verifying side, and the single most exploited mistake in
 * JWT's history is a verifier that trusts it — accepting `alg: none`, or
 * accepting HS256 signed with a public RSA key it thought was a public
 * key. The verifier in #7 will therefore ignore this header and check
 * HS256 because that is what this service issues, full stop.
 */
const HEADER = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

/**
 * HS256's MAC is 256 bits. A key shorter than that is the weakest part of
 * the construction — RFC 7518 §3.2 requires at least as many bits as the
 * hash output — so a 16-byte secret in an env var is refused rather than
 * quietly accepted.
 */
export const MIN_SECRET_BYTES = 32;

export class Hs256AccessTokenIssuer implements AccessTokenIssuer {
  private readonly secret: Buffer;

  constructor(secret: string) {
    const key = Buffer.from(secret, 'utf8');
    if (key.byteLength < MIN_SECRET_BYTES) {
      // The length, never the value. This message reaches logs.
      throw new Error(
        `the JWT secret must be at least ${MIN_SECRET_BYTES.toString()} bytes, got ${key.byteLength.toString()}.`,
      );
    }
    this.secret = key;
  }

  issue(claims: AccessTokenClaims): string {
    /**
     * Registered claim names, not descriptive ones. `sub` and `exp` are
     * defined by RFC 7519, which means every JWT tool on earth already
     * knows what they are; `userId` and `expiresAt` would be ours alone.
     *
     * `sid` is the one non-obvious entry: it scopes the token to a single
     * login rather than to the account, which is what makes revoking one
     * session possible later without invalidating every device.
     */
    const payload = base64url(
      JSON.stringify({
        sub: claims.userId,
        sid: claims.sessionId,
        // NumericDate: *seconds* since the epoch, not milliseconds. A
        // token issued with milliseconds here expires in the year 56000
        // and every verifier accepts it — the mistake is silent in both
        // directions, which is why the test asserts the unit.
        iat: toNumericDate(claims.issuedAt),
        exp: toNumericDate(claims.expiresAt),
      }),
    );

    const signingInput = `${HEADER}.${payload}`;
    const signature = createHmac('sha256', this.secret).update(signingInput).digest('base64url');

    return `${signingInput}.${signature}`;
  }
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function toNumericDate(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}
