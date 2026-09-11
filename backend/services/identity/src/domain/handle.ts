import { DomainValidationError } from './errors';

/**
 * 3-20 characters, letters/digits/underscore. Uniqueness is a separate
 * concern (HandleTakenError) resolved against the repository, and is
 * case-insensitive by column type (CITEXT) rather than by this pattern —
 * see docs/03-data-model.md.
 */
const HANDLE_PATTERN = /^[a-zA-Z0-9_]{3,20}$/;

export function assertValidHandle(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new DomainValidationError(
      'handle',
      'must be 3-20 characters: letters, digits, or underscore',
    );
  }
}
