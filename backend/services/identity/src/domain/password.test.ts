import { describe, expect, it } from 'vitest';
import { DomainValidationError } from './errors';
import { assertValidPassword } from './password';

describe('assertValidPassword', () => {
  it.each(['correcthorse1', 'Tr0ub4dor&3', '12345678a'])('accepts %s', (password) => {
    expect(() => {
      assertValidPassword(password);
    }).not.toThrow();
  });

  it.each([
    ['too short', 'a1a1a1a'],
    ['digits only', '12345678'],
    ['letters only', 'abcdefgh'],
    ['empty', ''],
  ])('rejects %s (%p)', (_label, password) => {
    expect(() => {
      assertValidPassword(password);
    }).toThrow(DomainValidationError);
  });

  it('names the offending field', () => {
    try {
      assertValidPassword('short');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      expect((error as DomainValidationError).field).toBe('password');
    }
  });
});
