import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';
import { Argon2PasswordHasher } from './argon2-password-hasher';

describe('Argon2PasswordHasher', () => {
  it('produces an argon2id hash that verifies against the original password', async () => {
    const hasher = new Argon2PasswordHasher();

    const hash = await hasher.hash('correcthorse1');

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(argon2.verify(hash, 'correcthorse1')).resolves.toBe(true);
    await expect(argon2.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  it('salts each hash, so the same password never hashes the same way twice', async () => {
    const hasher = new Argon2PasswordHasher();

    const [first, second] = await Promise.all([
      hasher.hash('correcthorse1'),
      hasher.hash('correcthorse1'),
    ]);

    expect(first).not.toBe(second);
  });
});
