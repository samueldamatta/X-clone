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

  it('verifies a password against its own hash', async () => {
    const hasher = new Argon2PasswordHasher();

    const hash = await hasher.hash('correcthorse1');

    await expect(hasher.verify(hash, 'correcthorse1')).resolves.toBe(true);
  });

  /**
   * False, not a throw. LoginUseCase relies on this: a wrong password is
   * the expected outcome of a working login, and an adapter that raised
   * would make the normal case travel the same path as a real fault.
   */
  it('answers false for a wrong password rather than throwing', async () => {
    const hasher = new Argon2PasswordHasher();

    const hash = await hasher.hash('correcthorse1');

    await expect(hasher.verify(hash, 'wrong-password')).resolves.toBe(false);
  });

  /**
   * The other half of that rule. A stored hash that is not a hash is a
   * corrupt row, not a failed login, and it must not be reported as one —
   * answering `false` here would quietly turn a broken database into
   * "wrong password" for every account it touched.
   */
  it('throws on a stored hash it cannot parse', async () => {
    const hasher = new Argon2PasswordHasher();

    await expect(hasher.verify('not-a-hash', 'correcthorse1')).rejects.toThrow();
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
