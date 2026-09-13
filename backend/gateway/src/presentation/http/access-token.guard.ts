import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';
import type { Request, Response } from 'express';
import {
  Hs256AccessTokenVerifier,
  type VerifiedAccessToken,
} from '../../infrastructure/security/hs256-access-token-verifier';

/** Only the method this guard calls — see the test for why not the concrete class. */
type AccessTokenVerifier = Pick<Hs256AccessTokenVerifier, 'verify'>;

/**
 * Where the guard leaves what it proved, for the param decorator below to
 * pick up. A property on the request object is Nest's idiom for this, and
 * the alternative — a request-scoped provider — would make every controller
 * that touches it request-scoped too, which costs a new instance per
 * request for the whole injection subtree.
 */
export interface AuthenticatedRequest extends Request {
  principal?: VerifiedAccessToken;
}

/**
 * Proves who the caller is, locally, before the controller runs.
 *
 * Everything expensive is on the far side of this: no gRPC call, no query,
 * no argon2, no write. An unauthenticated request costs one HMAC and stops.
 *
 * One thing does happen first, and it is worth being exact about rather
 * than claiming a purity this does not have. Express's JSON parser is
 * registered globally in main.ts, so the body is parsed *before* any guard
 * runs — Nest's request pipeline does not exist yet at that point. A
 * request with no token and a malformed body therefore answers 400, and one
 * over the 100 kB limit answers 413, in both cases without ever reaching
 * this class.
 *
 * That is a deviation from a strict reading of "rejected before any work is
 * done", and it is accepted for now. It leaks nothing about the token or
 * about any account — both answers are identical for a caller holding a
 * perfectly good token — and the work it admits is bounded by the parser's
 * own limit. The real defence against someone spending that budget in a
 * loop is rate limiting at the edge (#10), not guard ordering.
 * scripts/integration.sh pins the behaviour so it cannot drift unnoticed.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(@Inject(Hs256AccessTokenVerifier) private readonly verifier: AccessTokenVerifier) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();

    const token = readBearerToken(request.headers.authorization);
    if (token === undefined) {
      throw unauthorized(http.getResponse<Response>());
    }

    try {
      request.principal = this.verifier.verify(token);
    } catch {
      /**
       * The error is swallowed whole, and deliberately not logged.
       *
       * It carries no reason to begin with — InvalidAccessTokenError is one
       * type with one message, by design — but catching it without
       * inspection is what makes that structural rather than a convention
       * the next person has to notice. There is nothing here to accidentally
       * put in a response, and nothing in a log line that would let someone
       * with log access distinguish an expired token from a forged one.
       */
      throw unauthorized(http.getResponse<Response>());
    }

    return true;
  }
}

/**
 * `Authorization: Bearer <token>`, and nothing else.
 *
 * Exactly two space-separated parts. That rejects `Bearer a b`, and it
 * rejects the `Bearer x, Bearer y` that Node produces when a client sends
 * the header twice — a duplicate is ambiguous, and picking one of the two
 * is choosing which forgery to trust.
 *
 * The scheme is compared case-insensitively because RFC 7235 §2.1 says
 * auth-scheme is case-insensitive. The token is not: it is base64url, where
 * case is content.
 */
function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  const parts = header.split(' ');
  if (parts.length !== 2) {
    return undefined;
  }

  const [scheme, token] = parts as [string, string];
  if (scheme.toLowerCase() !== 'bearer' || token === '') {
    return undefined;
  }

  return token;
}

/**
 * One 401 for every failure: absent, malformed, expired, tampered, signed
 * with another key. Same status, same body, no `detail`, no `field`. The
 * ticket asks for exactly this, and the reason is the reason behind the
 * login rejection too — "expired" would tell an attacker their stolen token
 * is genuine and that only the clock stopped them.
 *
 * `WWW-Authenticate: Bearer` is set because RFC 7235 requires a 401 to say
 * how to authenticate. It is bare on purpose: RFC 6750 defines
 * `error="invalid_token"` and `error="expired_token"` parameters for this
 * header, and sending either would put the distinction back in the response
 * after all this care to keep it out.
 */
function unauthorized(response: Response): ProblemDetailsException {
  response.setHeader('WWW-Authenticate', 'Bearer');

  return new ProblemDetailsException({
    status: HttpStatus.UNAUTHORIZED,
    title: reasonPhrase(HttpStatus.UNAUTHORIZED),
  });
}

/**
 * Hands a controller the account the guard proved, and nothing else.
 *
 * A handler that took the id from a route parameter or from the body would
 * be one forgotten comparison away from letting one account write another's
 * data. This is the only supported way to learn who is calling, and it can
 * only answer after the guard has run.
 */
export function principalOf(context: ExecutionContext): VerifiedAccessToken {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

  if (request.principal === undefined) {
    /**
     * A plain Error, so this renders as 500 rather than 401 — and that is
     * the correct answer. Reaching here means @Principal() was used on a
     * route with no AccessTokenGuard: the request was never checked, and
     * the fault is ours, not the caller's. A 401 here would look like a
     * working authentication failure and hide the missing guard, which is
     * the bug that would let an unauthenticated request reach a handler.
     */
    throw new Error('@Principal() used on a route without AccessTokenGuard');
  }

  return request.principal;
}

/**
 * Split from `principalOf` above only so the rule can be tested directly:
 * a createParamDecorator's factory is reachable at runtime solely through
 * Nest's route-argument metadata, and a test that dug it out would be
 * asserting against a framework internal rather than against this file.
 */
export const Principal = createParamDecorator((_data: unknown, context: ExecutionContext) =>
  principalOf(context),
);
