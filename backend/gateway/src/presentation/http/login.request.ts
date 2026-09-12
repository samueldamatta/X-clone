import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';

/**
 * The public shape of POST /v1/auth/login. Field-for-field identical to
 * RegisterBody today, and deliberately a separate type: the two endpoints
 * are free to diverge (a login that accepts an email, say) without one
 * dragging the other along.
 */
export interface LoginBody {
  handle: string;
  password: string;
}

/**
 * Shape only, and even less than register's.
 *
 * Register rejects a missing password by name because the caller is
 * creating something and deserves to know what is wrong. Login says
 * nothing beyond "this was not a valid request body" — no `field` member,
 * and the same 400 whichever half is absent. A response naming `password`
 * would tell an enumerator that the handle they sent was at least
 * well-formed enough to get that far.
 *
 * This is a shape check, so it still answers 400 rather than 401: a body
 * that is not a JSON object with two strings never reached the credential
 * comparison at all, and pretending it did would mean spending an argon2id
 * hash on every malformed request an attacker cares to send.
 */
export function parseLoginBody(body: unknown): LoginBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest();
  }

  const fields = body as Record<string, unknown>;

  if (typeof fields.handle !== 'string' || typeof fields.password !== 'string') {
    throw badRequest();
  }

  return { handle: fields.handle, password: fields.password };
}

function badRequest(): ProblemDetailsException {
  return new ProblemDetailsException({
    status: HttpStatus.BAD_REQUEST,
    title: reasonPhrase(HttpStatus.BAD_REQUEST),
    // One message for every malformed shape, and no field. It never echoes
    // the body back either — that body contains a password.
    detail: 'expected a JSON object with a handle and a password',
  });
}
