import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AccessTokenClaims } from '../../domain/ports/access-token-issuer';
import { Hs256AccessTokenIssuer, MIN_SECRET_BYTES } from './hs256-access-token-issuer';

const SECRET = 'a'.repeat(MIN_SECRET_BYTES);
const ISSUED_AT = new Date('2026-09-11T12:00:00.000Z');
const EXPIRES_AT = new Date('2026-09-11T12:15:00.000Z');

const CLAIMS: AccessTokenClaims = {
  userId: '1847100000001',
  sessionId: '1847362819999',
  issuedAt: ISSUED_AT,
  expiresAt: EXPIRES_AT,
};

function decode(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function segments(token: string): { header: string; payload: string; signature: string } {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  return { header: parts[0] ?? '', payload: parts[1] ?? '', signature: parts[2] ?? '' };
}

describe('Hs256AccessTokenIssuer', () => {
  it('declares HS256 in the header', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);

    expect(decode(segments(token).header)).toEqual({ alg: 'HS256', typ: 'JWT' });
  });

  it('carries the account and the session as registered claims', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);

    expect(decode(segments(token).payload)).toEqual({
      sub: '1847100000001',
      sid: '1847362819999',
      iat: 1789128000,
      exp: 1789128900,
    });
  });

  /**
   * The acceptance criterion about lifetime, pinned to a unit rather than
   * to a duration. `exp` in milliseconds would put this token's expiry
   * somewhere in the year 58,000 — accepted by every verifier, forever,
   * and visibly wrong to nobody.
   */
  it('writes exp and iat in seconds, as NumericDate requires', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);
    const payload = decode(segments(token).payload) as { iat: number; exp: number };

    expect(payload.iat).toBe(ISSUED_AT.getTime() / 1000);
    expect(payload.exp - payload.iat).toBe(15 * 60);
  });

  /**
   * Verified independently: this recomputes the MAC from the token's own
   * first two segments rather than asking the issuer what it signed. A
   * test that reused the production helper would pass just as happily if
   * that helper signed the wrong bytes.
   */
  it('signs the header and payload with the secret', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);
    const { header, payload, signature } = segments(token);

    const expected = createHmac('sha256', Buffer.from(SECRET, 'utf8'))
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(signature).toBe(expected);
  });

  it('produces a signature a different secret cannot reproduce', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);
    const { header, payload, signature } = segments(token);

    const forged = createHmac('sha256', Buffer.from('b'.repeat(MIN_SECRET_BYTES), 'utf8'))
      .update(`${header}.${payload}`)
      .digest('base64url');

    expect(signature).not.toBe(forged);
  });

  /**
   * base64url, not base64. The difference is `+/=` versus `-_`, and a
   * token carrying a `+` breaks the moment it travels in a query string or
   * a form body, where `+` decodes as a space.
   */
  it('emits base64url segments, with no padding or URL-unsafe characters', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);

    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  /**
   * Snowflakes are strings in JSON everywhere in this system, and a JWT
   * payload is JSON like any other — `sub` as a number would lose
   * precision above 2^53-1 in every JavaScript client that decoded it.
   */
  it('keeps the ids as strings', () => {
    const token = new Hs256AccessTokenIssuer(SECRET).issue(CLAIMS);
    const payload = decode(segments(token).payload) as { sub: unknown; sid: unknown };

    expect(typeof payload.sub).toBe('string');
    expect(typeof payload.sid).toBe('string');
  });

  it('refuses a secret shorter than the MAC it produces', () => {
    expect(() => new Hs256AccessTokenIssuer('short')).toThrow(/at least 32 bytes/);
  });

  /**
   * The message reaches logs, and a rejected secret is still a secret —
   * one typo away from the one that works.
   */
  it('does not put the secret in the error it raises', () => {
    let message = '';
    try {
      new Hs256AccessTokenIssuer('hunter2');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });
});
