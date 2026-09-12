import { ProblemDetailsException } from '@x-clone/problem-details';
import { describe, expect, it } from 'vitest';
import { parseUpdateProfileBody } from './update-profile.request';

function fieldOf(body: unknown): string | undefined {
  try {
    parseUpdateProfileBody(body);
    return 'accepted';
  } catch (error) {
    return (error as ProblemDetailsException).field;
  }
}

describe('parseUpdateProfileBody', () => {
  it('keeps both fields when both are sent', () => {
    expect(parseUpdateProfileBody({ displayName: 'Sam', bio: 'hello' })).toEqual({
      displayName: 'Sam',
      bio: 'hello',
    });
  });

  it('omits an absent field rather than carrying it as undefined', () => {
    const parsed = parseUpdateProfileBody({ displayName: 'Sam' });

    // The single most important assertion in this file. Every layer below
    // reads presence with `!== undefined`; a key holding undefined would
    // travel as a request to clear the bio.
    expect(parsed).toEqual({ displayName: 'Sam' });
    expect('bio' in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual(['displayName']);
  });

  it('keeps an empty string, which is how a bio is cleared', () => {
    const parsed = parseUpdateProfileBody({ bio: '' });

    expect('bio' in parsed).toBe(true);
    expect(parsed.bio).toBe('');
  });

  it('does not invent fields from an empty object', () => {
    // Not an error here: Identity owns the "a patch must ask for something"
    // rule, and refusing it in two places means two rules to keep in step.
    expect(parseUpdateProfileBody({})).toEqual({});
  });

  it('ignores fields it does not know', () => {
    // Including the near-misses. `displayname` parses to an empty patch and
    // is refused by Identity, rather than quietly renaming nothing.
    expect(parseUpdateProfileBody({ displayname: 'Sam', id: '999', handle: 'other' })).toEqual({});
  });

  it('never lets the body name whose profile to change', () => {
    const parsed = parseUpdateProfileBody({ userId: '999', id: '999', displayName: 'Sam' });

    expect(parsed).toEqual({ displayName: 'Sam' });
  });

  it.each([
    ['a string', '"nope"'],
    ['an array', []],
    ['null', null],
    ['a number', 7],
  ])('refuses a body that is %s', (_label, body) => {
    expect(() => parseUpdateProfileBody(body)).toThrow(ProblemDetailsException);
  });

  it.each([
    ['displayName', { displayName: 42 }],
    ['bio', { bio: [] }],
  ])('names %s when it is not a string', (field, body) => {
    expect(fieldOf(body)).toBe(field);
  });

  it('refuses null rather than reading it as "clear this field"', () => {
    // A common PATCH convention, deliberately not adopted: this API already
    // spells that instruction `""`, and two spellings of one instruction is
    // one too many.
    expect(fieldOf({ bio: null })).toBe('bio');
  });

  it('does not echo the rejected value back', () => {
    try {
      parseUpdateProfileBody({ displayName: { secret: 'do-not-quote-me' } });
      expect.unreachable();
    } catch (error) {
      expect(JSON.stringify((error as ProblemDetailsException).toBody())).not.toContain(
        'do-not-quote-me',
      );
    }
  });
});
