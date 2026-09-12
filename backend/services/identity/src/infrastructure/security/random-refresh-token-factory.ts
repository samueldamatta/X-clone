import { createHash, randomBytes } from 'node:crypto';
import type { RefreshToken, RefreshTokenFactory } from '../../domain/ports/refresh-token-factory';

/**
 * 256 bits. The number that makes the SHA-256 below sufficient, so the two
 * constants are not independent: guessing a token means searching 2^256,
 * which no amount of hardware shortens into a threat.
 */
const TOKEN_BYTES = 32;

/**
 * Opaque, unlike the access token: this string means nothing, carries
 * nothing, and can be understood by nobody holding it. It is a lookup key
 * for a row in `identity.sessions`, which is precisely what makes revoking
 * it possible — there is nothing to revoke about a self-describing JWT
 * except waiting for it to expire.
 *
 * **Why SHA-256 and not argon2id, when passwords next door get argon2id.**
 * Argon2 is deliberately slow because a human password holds maybe 30 bits
 * of entropy and the slowness is what makes guessing it uneconomic. This
 * token holds 256 bits from a CSPRNG. There is no dictionary to run, no
 * guessing to price, and nothing for the slowness to buy — it would be
 * pure latency on the refresh path, which #8 puts on every client every
 * fifteen minutes. Fast hashing is right here for exactly the reason it is
 * wrong for passwords.
 */
export class RandomRefreshTokenFactory implements RefreshTokenFactory {
  create(): RefreshToken {
    // randomBytes, not Math.random: the latter is a PRNG seeded from
    // nothing secret, and its output is predictable from prior output.
    // This is the distinction between a secret and a number that looks
    // messy.
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    return { token, hash: hashRefreshToken(token) };
  }
}

/**
 * Exported because #8 needs the same function to look a token back up —
 * it hashes what the client presents and compares against the stored
 * column. Two copies of this would drift, and the failure mode is a
 * refresh endpoint that never matches anything.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
