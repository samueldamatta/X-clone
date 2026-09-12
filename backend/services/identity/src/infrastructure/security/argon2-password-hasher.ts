import * as argon2 from 'argon2';
import type { PasswordHasher } from '../../domain/ports/password-hasher';

/**
 * argon2id — the memory-hard algorithm named in docs/03-data-model.md.
 * argon2's default `type` is already argon2id; passed explicitly so a
 * future default change in the library cannot silently weaken this.
 */
export class Argon2PasswordHasher implements PasswordHasher {
  hash(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  /**
   * No `type` option here, and that is not an omission: argon2.verify reads
   * the algorithm and every parameter — memory cost, iterations, salt —
   * out of the encoded hash it is given. That is what makes the parameters
   * above safe to change later. Hashes written under the old settings keep
   * verifying under the settings they were written with.
   *
   * Constant-time comparison is argon2's own doing, not ours.
   */
  verify(hash: string, password: string): Promise<boolean> {
    return argon2.verify(hash, password);
  }
}
