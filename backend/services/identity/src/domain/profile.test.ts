import { describe, expect, it } from 'vitest';
import { DomainValidationError } from './errors';
import { normalizeBio, normalizeDisplayName } from './profile';

describe('normalizeDisplayName', () => {
  it.each(['Sam', 'Sam D’Amatta', '中文名字', 'a'.repeat(50)])('accepts %p', (displayName) => {
    expect(normalizeDisplayName(displayName)).toBe(displayName);
  });

  it('trims, and returns the value that must be stored', () => {
    // The point of returning rather than asserting: a caller that validated
    // in place would persist the untrimmed original.
    expect(normalizeDisplayName('  Sam  ')).toBe('Sam');
  });

  it('rejects a name that is only whitespace, which trim() turns into empty', () => {
    expect(() => normalizeDisplayName('   ')).toThrow(DomainValidationError);
  });

  it.each([
    ['empty', ''],
    ['a newline', 'Sam\nDamatta'],
    ['a tab', 'Sam\tDamatta'],
    ['a NUL', 'Sam\u0000'],
    ['DEL', 'Sam\u007f'],
  ])('rejects %s', (_label, displayName) => {
    expect(() => normalizeDisplayName(displayName)).toThrow(DomainValidationError);
  });

  it.each([
    ['a right-to-left override', 'admin\u202eeurt'],
    ['a zero-width space', 'Sam\u200bDamatta'],
    ['a word joiner', 'Sam\u2060Damatta'],
    ['a BOM in the middle', 'Sam\ufeffDamatta'],
  ])('rejects %s, which is invisible in every UI that renders it', (_label, displayName) => {
    expect(() => normalizeDisplayName(displayName)).toThrow(DomainValidationError);
  });

  it('measures length in code points, not UTF-16 code units', () => {
    // 50 birds: 50 characters a human would count, 100 units of
    // String.length. Counting units would refuse this and accept only 25.
    const fifty = '\u{1F426}'.repeat(50);
    expect(fifty.length).toBe(100);
    expect(normalizeDisplayName(fifty)).toBe(fifty);

    expect(() => normalizeDisplayName('\u{1F426}'.repeat(51))).toThrow(DomainValidationError);
  });

  it('rejects a name longer than the limit', () => {
    expect(() => normalizeDisplayName('a'.repeat(51))).toThrow(DomainValidationError);
  });

  it('names the offending field', () => {
    try {
      normalizeDisplayName('');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      expect((error as DomainValidationError).field).toBe('displayName');
    }
  });
});

describe('normalizeBio', () => {
  it('accepts an empty bio, because clearing one is a thing people do', () => {
    expect(normalizeBio('')).toBe('');
    expect(normalizeBio('   ')).toBe('');
  });

  it('keeps newlines: a bio is a block of text, not a single line', () => {
    expect(normalizeBio('line one\nline two')).toBe('line one\nline two');
  });

  it('folds CRLF, which is what a browser textarea submits', () => {
    expect(normalizeBio('line one\r\nline two')).toBe('line one\nline two');
  });

  it.each([
    ['a lone carriage return', 'a\rb'],
    ['a NUL', 'a\u0000b'],
    ['a vertical tab', 'a\u000bb'],
  ])('rejects %s', (_label, bio) => {
    expect(() => normalizeBio(bio)).toThrow(DomainValidationError);
  });

  it('allows the bidi controls a display name refuses, because prose needs them', () => {
    expect(normalizeBio('\u202bHebrew text here\u202c')).toContain('Hebrew');
  });

  it('rejects a bio longer than the limit', () => {
    expect(normalizeBio('a'.repeat(160))).toBe('a'.repeat(160));
    expect(() => normalizeBio('a'.repeat(161))).toThrow(DomainValidationError);
  });

  it('names the offending field', () => {
    try {
      normalizeBio('a'.repeat(161));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainValidationError);
      expect((error as DomainValidationError).field).toBe('bio');
    }
  });
});
