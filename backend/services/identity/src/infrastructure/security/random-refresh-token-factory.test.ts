import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hashRefreshToken, RandomRefreshTokenFactory } from './random-refresh-token-factory';

describe('RandomRefreshTokenFactory', () => {
  it('mints 256 bits of entropy, encoded base64url', () => {
    const { token } = new RandomRefreshTokenFactory().create();

    // 32 bytes in base64 is 43 characters plus one '=' of padding, which
    // base64url drops.
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  /**
   * The whole security property, as far as a unit test can reach it. It
   * cannot prove the source is a CSPRNG — only that the output is not a
   * constant, a counter, or otherwise repeating.
   */
  it('never mints the same token twice', () => {
    const factory = new RandomRefreshTokenFactory();

    const tokens = new Set(Array.from({ length: 1000 }, () => factory.create().token));

    expect(tokens.size).toBe(1000);
  });

  it('pairs each token with the SHA-256 of that same token', () => {
    const { token, hash } = new RandomRefreshTokenFactory().create();

    expect(hash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(hash).toHaveLength(64);
  });

  /**
   * What the database must not be able to give back. The hash is what gets
   * stored; if the token were recoverable from it, storing the hash would
   * be theatre.
   */
  it('produces a hash that does not contain the token', () => {
    const { token, hash } = new RandomRefreshTokenFactory().create();

    expect(hash).not.toContain(token);
  });

  /**
   * #8 hashes the token a client presents and compares it against the
   * stored column. That only works if this function is the same one that
   * wrote the column.
   */
  it('reproduces the stored hash from the token alone', () => {
    const { token, hash } = new RandomRefreshTokenFactory().create();

    expect(hashRefreshToken(token)).toBe(hash);
  });

  it('hashes different tokens differently', () => {
    expect(hashRefreshToken('one')).not.toBe(hashRefreshToken('two'));
  });
});
