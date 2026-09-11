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
}
