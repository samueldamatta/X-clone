import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';

/**
 * The public shape of POST /v1/auth/register.
 *
 * Deliberately not the proto's RegisterRequest, even though the two are
 * field-for-field identical today: the contract with browsers and the wire
 * contract with Identity are allowed to drift, and a field added to the
 * .proto must not become public because nothing stood between them.
 */
export interface RegisterBody {
  handle: string;
  password: string;
}

/**
 * Shape only — is there a handle, is it a string.
 *
 * Whether the handle is well-formed, and whether the password is strong
 * enough, belongs to Identity (domain/handle.ts, domain/password.ts) and is
 * deliberately not restated here. Two copies of one rule drift, and the
 * copy the user hits first is the one that is wrong.
 *
 * The cost is a network round trip to reject "abc" as a password. What it
 * buys is one place where that rule lives.
 */
export function parseRegisterBody(body: unknown): RegisterBody {
  // Arrays are objects too, and `[]` reaching requireString would report a
  // missing handle rather than a body that was never an object.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('expected a JSON object body');
  }

  const fields = body as Record<string, unknown>;

  // Handle first, matching the order RegisterUserUseCase validates in, so
  // a request wrong in both fields names the same one on either path.
  return {
    handle: requireString(fields.handle, 'handle'),
    password: requireString(fields.password, 'password'),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    // The detail never echoes the value back. For `password` that would
    // copy the rejected secret into the response body, and from there into
    // every access log and error tracker that records one.
    throw badRequest(value === undefined ? 'is required' : 'must be a string', field);
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
