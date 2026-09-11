import { describe, expect, it } from 'vitest';
import { DomainValidationError } from './errors';
import { assertValidHandle } from './handle';

describe('assertValidHandle', () => {
  it.each(['sam', 'sam_23', 'A'.repeat(20)])('accepts %s', (handle) => {
    expect(() => {
      assertValidHandle(handle);
    }).not.toThrow();
  });

  it.each([
    ['too short', 'sa'],
    ['too long', 'a'.repeat(21)],
    ['empty', ''],
    ['contains a space', 'sam damatta'],
    ['contains a dot', 'sam.damatta'],
    ['contains an emoji', 'sam🐦'],
  ])('rejects %s (%p)', (_label, handle) => {
    expect(() => {
      assertValidHandle(handle);
    }).toThrow(DomainValidationError);
  });

  it('names the offending field', () => {
    try {
      assertValidHandle('a');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      expect((error as DomainValidationError).field).toBe('handle');
    }
  });
});
