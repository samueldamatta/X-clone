import { ProblemDetailsException } from '@x-clone/problem-details';
import { describe, expect, it } from 'vitest';
import { parseRegisterBody } from './register.request';

function rejection(body: unknown): ProblemDetailsException {
  try {
    parseRegisterBody(body);
  } catch (error) {
    return error as ProblemDetailsException;
  }
  return expect.unreachable('expected parseRegisterBody to reject');
}

describe('parseRegisterBody', () => {
  it('accepts a well-formed body and drops everything else in it', () => {
    // `isAdmin` is the reason this returns a new object rather than the
    // body: a caller must not be able to smuggle a field through to the
    // gRPC request by inventing one.
    expect(parseRegisterBody({ handle: 'sam', password: 'correcthorse1', isAdmin: true })).toEqual({
      handle: 'sam',
      password: 'correcthorse1',
    });
  });

  it('does not judge whether the handle or password are any good', () => {
    // Identity's job, not this one. A parser that also enforced length
    // would be a second copy of a rule that lives in domain/password.ts.
    expect(parseRegisterBody({ handle: '!!', password: 'x' })).toEqual({
      handle: '!!',
      password: 'x',
    });
  });

  it('rejects a body that is not a JSON object', () => {
    for (const body of ['a string', 42, null, undefined, ['sam', 'hunter2']]) {
      const problem = rejection(body);
      expect(problem.getStatus()).toBe(400);
      expect(problem.toBody().detail).toBe('expected a JSON object body');
    }
  });

  it('names the missing field rather than reporting a generic failure', () => {
    expect(rejection({ password: 'correcthorse1' }).toBody()).toEqual({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'is required',
      field: 'handle',
    });

    expect(rejection({ handle: 'sam' }).toBody().field).toBe('password');
  });

  it('distinguishes a field of the wrong type from a missing one', () => {
    expect(rejection({ handle: 12345, password: 'correcthorse1' }).toBody()).toMatchObject({
      detail: 'must be a string',
      field: 'handle',
    });
  });

  it('never echoes the rejected password back to the caller', () => {
    // A response body is copied into access logs and error trackers. A
    // secret that reaches one has reached all of them.
    const problem = rejection({ handle: 'sam', password: { leaked: 'hunter2' } });

    expect(JSON.stringify(problem.toBody())).not.toContain('hunter2');
    expect(problem.toBody().field).toBe('password');
  });
});
