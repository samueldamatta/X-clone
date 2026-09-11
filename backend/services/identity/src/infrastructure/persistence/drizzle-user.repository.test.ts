import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './drizzle-user.repository';

describe('isUniqueViolation', () => {
  it('recognizes a raw pg error carrying .code directly', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('unwraps DrizzleQueryError, which puts the pg error on .cause rather than on itself', () => {
    // What drizzle-orm 0.45.2 actually throws: a wrapper error whose own
    // `.code` is absent, with the driver error (which has it) as .cause.
    // A prior version of this check looked only at the top-level error and
    // missed every real unique-violation from the database as a result.
    const wrapped = new Error('Failed query');
    (wrapped as { cause?: unknown }).cause = { code: '23505' };

    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('does not misfire on an unrelated pg error code', () => {
    expect(isUniqueViolation({ code: '23502' })).toBe(false);
  });

  it('is false for non-error values', () => {
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation('boom')).toBe(false);
  });
});
