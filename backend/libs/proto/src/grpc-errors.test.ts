import { Metadata } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { readFieldViolation, withFieldViolation } from './grpc-errors';

describe('field violation metadata', () => {
  it('round-trips through Metadata', () => {
    const metadata = withFieldViolation(new Metadata(), {
      field: 'password',
      reason: 'must be at least 8 characters',
    });

    expect(readFieldViolation(metadata)).toEqual({
      field: 'password',
      reason: 'must be at least 8 characters',
    });
  });

  it('returns undefined when no violation was set', () => {
    expect(readFieldViolation(new Metadata())).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    const metadata = new Metadata();
    metadata.set('x-field-violation', 'not-json');

    expect(readFieldViolation(metadata)).toBeUndefined();
  });

  it('returns undefined when the shape is missing a required key', () => {
    const metadata = new Metadata();
    metadata.set('x-field-violation', JSON.stringify({ field: 'handle' }));

    expect(readFieldViolation(metadata)).toBeUndefined();
  });
});
