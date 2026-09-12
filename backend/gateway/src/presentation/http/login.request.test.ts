import { ProblemDetailsException } from '@x-clone/problem-details';
import { describe, expect, it } from 'vitest';
import { parseLoginBody } from './login.request';

function rejection(body: unknown): ProblemDetailsException {
  try {
    parseLoginBody(body);
  } catch (error) {
    return error as ProblemDetailsException;
  }
  return expect.unreachable('parseLoginBody was expected to reject');
}

describe('parseLoginBody', () => {
  it('accepts a well-formed body', () => {
    expect(parseLoginBody({ handle: 'sam', password: 'correcthorse1' })).toEqual({
      handle: 'sam',
      password: 'correcthorse1',
    });
  });

  it('keeps only the two fields it knows about', () => {
    const parsed = parseLoginBody({ handle: 'sam', password: 'p', isAdmin: true });

    expect(Object.keys(parsed).sort()).toEqual(['handle', 'password']);
  });

  /**
   * Unlike register, which names the offending field. Saying `password` is
   * missing confirms that the handle alongside it was at least a string —
   * a small answer, but an answer, to someone working through a list of
   * handles. The 401 path gives nothing away; this one must not either.
   */
  it.each([
    ['a missing password', { handle: 'sam' }],
    ['a missing handle', { password: 'correcthorse1' }],
    ['a non-string handle', { handle: 42, password: 'correcthorse1' }],
    ['a non-string password', { handle: 'sam', password: null }],
  ])('rejects %s without naming a field', (_case, body) => {
    const error = rejection(body);

    expect(error).toBeInstanceOf(ProblemDetailsException);
    expect(error.getStatus()).toBe(400);
    expect(Object.keys(error.toBody())).not.toContain('field');
  });

  it('answers every malformed shape with the same message', () => {
    const messages = new Set(
      [{ handle: 'sam' }, { password: 'p' }, {}, [], 'nope', 42, null].map(
        (body) => rejection(body).toBody().detail,
      ),
    );

    expect(messages.size).toBe(1);
  });

  /**
   * The body being rejected contains a password. Quoting any of it back
   * would copy that password into the response, and from there into every
   * access log and error tracker that records one — the same reasoning as
   * presentation/http/json-body.ts.
   */
  it('never echoes the rejected body back', () => {
    // Malformed (the handle is not a string) but still carrying a real
    // password — which is exactly the case where echoing would leak one.
    const error = rejection({ handle: 42, password: 'hunter2' });

    expect(JSON.stringify(error.toBody())).not.toContain('hunter2');
  });

  it('rejects an array, which is an object but not a body', () => {
    expect(rejection([]).getStatus()).toBe(400);
  });

  it('rejects a 400 rather than a 401, since nothing was ever compared', () => {
    // The distinction matters: a 401 here would mean the credentials were
    // checked and refused, and checking costs an argon2id hash. A shape
    // this wrong never gets that far, and must not cost that.
    expect(rejection({}).getStatus()).toBe(400);
  });
});
