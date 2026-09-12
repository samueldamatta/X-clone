import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';

/**
 * The public shape of PATCH /v1/users/me.
 *
 * Both fields optional, and that is the difference between a PATCH and a
 * PUT: an omitted field means "leave it alone", so a client renaming itself
 * does not have to resend a bio it never read. The whole chain below this —
 * this parser, the gRPC client, the `optional` keyword in identity.proto,
 * the use case — exists to carry that distinction intact, because collapsing
 * it means a rename silently erases a bio.
 *
 * There is no `id` field, and there never will be. Whose profile this is
 * comes from the access token, which is why one account cannot edit
 * another's.
 */
export interface UpdateProfileBody {
  displayName?: string;
  bio?: string;
}

/**
 * Shape only: is it an object, and is each field it *did* send a string.
 *
 * What a display name may contain, and how long a bio may be, belong to
 * Identity (domain/profile.ts) and are deliberately not restated here —
 * same rule as parseRegisterBody, same reason: two copies of one rule
 * drift, and the copy the user hits first is the one that is wrong.
 *
 * Unknown fields are ignored rather than rejected, which has a consequence
 * worth stating: `{"displayname": "Sam"}` — wrong case, the typo everyone
 * makes once — parses to an empty patch. It is not silently accepted; it
 * travels to Identity, which refuses an update that asks for nothing. The
 * rejection is one network hop later than it could be, and it is in the one
 * place that owns the rule.
 */
export function parseUpdateProfileBody(body: unknown): UpdateProfileBody {
  // Arrays are objects too. `[]` falling through would parse as a body with
  // no fields, and be reported as an empty patch rather than as the wrong
  // kind of thing entirely.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('expected a JSON object body');
  }

  const fields = body as Record<string, unknown>;

  /**
   * Built by spreading only what is present, never by assigning
   * `displayName: fields.displayName`. That version would put the key on
   * the object holding undefined, and every layer below reads presence with
   * `!== undefined` — so an omitted field would arrive looking like a
   * request to change something.
   */
  return {
    ...(fields.displayName !== undefined && {
      displayName: requireString(fields.displayName, 'displayName'),
    }),
    ...(fields.bio !== undefined && { bio: requireString(fields.bio, 'bio') }),
  };
}

/**
 * `null` is refused rather than read as "clear this field", even though
 * that is a common convention in PATCH bodies.
 *
 * The reason is that this API already has a way to clear a string field:
 * send `""`. Supporting both would mean two spellings of one instruction,
 * and the day a non-string field arrives — an avatar id, say — `null` would
 * have to mean something different again. The cost is that a client
 * generating JSON from a nullable object has to strip its nulls.
 */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    // Never echoes the value back.
    throw badRequest('must be a string', field);
  }
  return value;
}

function badRequest(detail: string, field?: string): ProblemDetailsException {
  return new ProblemDetailsException({
    status: HttpStatus.BAD_REQUEST,
    title: reasonPhrase(HttpStatus.BAD_REQUEST),
    detail,
    ...(field !== undefined && { field }),
  });
}
