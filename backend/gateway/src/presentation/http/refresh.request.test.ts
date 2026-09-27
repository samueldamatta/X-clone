import { ProblemDetailsException } from '@x-clone/problem-details';
import { describe, expect, it } from 'vitest';
import { parseRefreshBody } from './refresh.request';

function rejection(body: unknown): ProblemDetailsException {
  try {
    parseRefreshBody(body);
  } catch (error) {
    return error as ProblemDetailsException;
  }
  return expect.unreachable('parseRefreshBody was expected to reject');
}

describe('parseRefreshBody', () => {
  it('accepts a body carrying a refresh token, and keeps only that', () => {
    expect(parseRefreshBody({ refreshToken: 'opaque-1', userId: '1' })).toEqual({
      refreshToken: 'opaque-1',
    });
  });

  // Unlike login, naming the field here answers nothing: there is only one, and no account to enumerate.
  it.each([
    ['a missing token', {}],
    ['a non-string token', { refreshToken: 42 }],
  ])('rejects %s as a 400 naming the field', (_case, body) => {
    const error = rejection(body);

    expect(error.getStatus()).toBe(400);
    expect(error.toBody().field).toBe('refreshToken');
  });

  it.each([
    ['null', null],
    ['an array', ['opaque-1']],
    ['a string', 'opaque-1'],
  ])('rejects %s as a body that is not an object', (_case, body) => {
    const error = rejection(body);

    expect(error.getStatus()).toBe(400);
    expect(error.toBody().field).toBeUndefined();
  });

  it('never echoes the token back in a rejection', () => {
    const error = rejection({ refreshToken: { value: 'opaque-secret' } });

    expect(JSON.stringify(error.toBody())).not.toContain('opaque-secret');
  });
});
