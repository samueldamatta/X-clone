import { DomainValidationError } from './errors';

/**
 * The public face of an account.
 *
 * `id` is here, and it rather than `handle` is the identity. A handle can
 * be renamed, and every reference made through one would break the day it
 * is — a mention, a bookmark, a follow row. The Snowflake never changes,
 * so everything internal points at that and the handle is only how a human
 * addresses the account. That is why the profile exposes both.
 *
 * No follower or following count yet, even though `identity.users` has
 * columns for them. Nothing writes those columns until the Graph service
 * exists, so publishing them now would mean every profile in the API
 * reporting zero followers as a fact. An absent field is honest; a field
 * that is structurally always 0 is not.
 */
export interface Profile {
  readonly id: string;
  readonly handle: string;
  readonly displayName: string;
  readonly bio: string;
  readonly createdAt: Date;
}

/**
 * What a PATCH may change. Absent means "leave it alone" — which is the
 * whole reason this is a partial update and not a replacement: a client
 * that wants to rename itself must not have to resend a bio it never read,
 * and an omitted field must never be read as an instruction to erase one.
 *
 * An empty string is therefore *not* the same as absent. `bio: ''` is a
 * person clearing their bio, and it has to survive the trip intact — see
 * identity.proto, where this is the reason both fields are `optional`.
 */
export interface ProfileChanges {
  displayName?: string;
  bio?: string;
}

/** Twitter's own limits, and long enough that nobody normal meets them. */
const DISPLAY_NAME_MAX = 50;
const BIO_MAX = 160;

/**
 * Counted in code points, not in `String.length`.
 *
 * `'sam\u{1F426}'.length` is 5, because JavaScript strings are UTF-16 and
 * an emoji outside the BMP takes two code units. Measuring that way charges
 * a person double for one character they can see, and makes the limit
 * published in the docs depend on the alphabet they write in. The spread
 * operator iterates code points, which is the cheap approximation of
 * "characters a human would count".
 *
 * It is still an approximation: a flag emoji is two code points, and an
 * accented letter may be one or two depending on normalisation form. The
 * real answer is `Intl.Segmenter` with grapheme granularity, and it is not
 * worth the complexity for a length check.
 */
function countCharacters(value: string): number {
  return [...value].length;
}

/**
 * C0 controls and DEL, found by scanning rather than by a regex.
 *
 * The regex spelling of this is a character class over U+0000-U+001F and
 * U+007F, and ESLint's `no-control-regex` refuses it — for a good reason
 * that does not apply here: almost every control character inside a pattern
 * got there by accident, from a paste or a bad escape. Ours are the thing
 * being looked for. Suppressing the rule would work; scanning code points
 * instead costs three lines, needs no suppression comment for a future
 * reader to have to evaluate, and matches how length is already counted
 * above.
 *
 * Why it matters at all: a display name is rendered inline, on one line, on
 * every surface that shows it. A newline or a backspace in one is either a
 * broken layout or a deliberate attempt to make a name look like something
 * it is not. A bio is a block of text, so it is scanned with newlines
 * allowed — they are what it is for.
 */
const LINE_FEED = 0x0a;
const DELETE = 0x7f;
const FIRST_PRINTABLE = 0x20;

function hasControlCharacters(value: string, allowNewline: boolean): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (allowNewline && code === LINE_FEED) {
      continue;
    }
    if (code < FIRST_PRINTABLE || code === DELETE) {
      return true;
    }
  }
  return false;
}

/**
 * Zero-width and bidirectional-control characters, rejected in a display
 * name specifically.
 *
 * U+202E (RIGHT-TO-LEFT OVERRIDE) reverses the rendering of everything
 * after it, so a name stored as `admin` + U+202E + `eurt` renders as
 * `admintrue`; U+200B (ZERO WIDTH SPACE) lets two visually identical
 * names exist as distinct strings, which defeats any "is this the same
 * person" judgement a reader makes by eye. Both are invisible, which is
 * exactly what makes them worth refusing rather than rendering.
 *
 * Not applied to a bio: a bio is prose, it may legitimately be written in
 * Hebrew or Arabic, and the bidi isolates exist for that.
 */
const INVISIBLE_CHARACTERS = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/**
 * Trims, then validates — in that order, and the order matters. A display
 * name of `'   '` is three characters long and empty at the same time;
 * validating first would accept it and store whitespace as somebody's name.
 *
 * Returns the value to store rather than asserting in place, because the
 * trimmed string is the thing that must reach the database. An
 * `assertValidDisplayName` that left the caller holding the untrimmed
 * original would validate one value and persist another.
 */
export function normalizeDisplayName(displayName: string): string {
  const trimmed = displayName.trim();

  if (trimmed === '') {
    throw new DomainValidationError('displayName', 'must not be empty');
  }
  if (hasControlCharacters(trimmed, false)) {
    throw new DomainValidationError('displayName', 'must not contain control characters');
  }
  if (INVISIBLE_CHARACTERS.test(trimmed)) {
    throw new DomainValidationError('displayName', 'must not contain invisible characters');
  }
  if (countCharacters(trimmed) > DISPLAY_NAME_MAX) {
    throw new DomainValidationError(
      'displayName',
      `must be at most ${DISPLAY_NAME_MAX.toString()} characters`,
    );
  }

  return trimmed;
}

/**
 * Unlike a display name, empty is legal: clearing a bio is a thing people
 * do, and the column defaults to '' for every account that never set one.
 *
 * CRLF is folded to LF before the control-character check rather than
 * rejected by it. A browser's textarea submits `\r\n` for every line break
 * — refusing that would mean refusing the bio of anyone who pressed Enter,
 * and blaming them for their form control.
 */
export function normalizeBio(bio: string): string {
  const trimmed = bio.replace(/\r\n/g, '\n').trim();

  if (hasControlCharacters(trimmed, true)) {
    throw new DomainValidationError('bio', 'must not contain control characters');
  }
  if (countCharacters(trimmed) > BIO_MAX) {
    throw new DomainValidationError('bio', `must be at most ${BIO_MAX.toString()} characters`);
  }

  return trimmed;
}
