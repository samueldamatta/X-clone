import { ExecutionContext } from '@nestjs/common';
import { ProblemDetailsException } from '@x-clone/problem-details';
import { describe, expect, it, vi } from 'vitest';
import {
  InvalidAccessTokenError,
  type VerifiedAccessToken,
} from '../../infrastructure/security/hs256-access-token-verifier';
import { AccessTokenGuard, principalOf, type AuthenticatedRequest } from './access-token.guard';

const PRINCIPAL: VerifiedAccessToken = {
  userId: '1847100000001',
  sessionId: '1847100000002',
  expiresAt: new Date('2026-09-12T12:15:00.000Z'),
};

interface Harness {
  context: ExecutionContext;
  request: AuthenticatedRequest;
  setHeader: ReturnType<typeof vi.fn>;
}

function contextWith(authorization?: string): Harness {
  const request = { headers: { authorization } } as unknown as AuthenticatedRequest;
  const setHeader = vi.fn();

  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ setHeader }),
    }),
  } as unknown as ExecutionContext;

  return { context, request, setHeader };
}

/** Accepts anything, so header parsing can be tested apart from verification. */
const acceptingVerifier = { verify: () => PRINCIPAL };

const rejectingVerifier = {
  verify: () => {
    throw new InvalidAccessTokenError();
  },
};

function problem(error: unknown): { status: number; body: Record<string, unknown> } {
  const exception = error as ProblemDetailsException;
  return {
    status: exception.getStatus(),
    body: exception.toBody() as unknown as Record<string, unknown>,
  };
}

describe('AccessTokenGuard, the happy path', () => {
  it('admits a request carrying a valid bearer token', () => {
    const { context, request } = contextWith('Bearer a.b.c');

    expect(new AccessTokenGuard(acceptingVerifier).canActivate(context)).toBe(true);
    expect(request.principal).toEqual(PRINCIPAL);
  });

  it('accepts the scheme in any case, as RFC 7235 says to', () => {
    const { context } = contextWith('bearer a.b.c');

    expect(new AccessTokenGuard(acceptingVerifier).canActivate(context)).toBe(true);
  });

  it('passes the token through untouched, case included', () => {
    let seen: string | undefined;
    const guard = new AccessTokenGuard({
      verify: (token: string) => {
        seen = token;
        return PRINCIPAL;
      },
    });

    guard.canActivate(contextWith('Bearer AbC.dEf.GhI').context);

    // base64url, where case is content: lower-casing the token the way the
    // scheme is lower-cased would invalidate every signature.
    expect(seen).toBe('AbC.dEf.GhI');
  });
});

describe('the header itself', () => {
  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['the wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['a scheme with no token', 'Bearer'],
    ['a scheme with an empty token', 'Bearer '],
    ['the bare token, with no scheme', 'a.b.c'],
    ['extra parts', 'Bearer a.b.c extra'],
    // What Node produces when a client sends Authorization twice. Choosing
    // one of the two is choosing which forgery to trust.
    ['the header sent twice', 'Bearer a.b.c, Bearer d.e.f'],
  ])('refuses %s', (_label, authorization) => {
    const { context } = contextWith(authorization);

    expect(() => new AccessTokenGuard(acceptingVerifier).canActivate(context)).toThrow(
      ProblemDetailsException,
    );
  });

  it('never reaches the verifier when the header is unusable', () => {
    const verify = vi.fn();
    const { context } = contextWith('Basic dXNlcjpwYXNz');

    expect(() => new AccessTokenGuard({ verify }).canActivate(context)).toThrow();

    // "Rejected before any work is done", as the ticket puts it — not even
    // one HMAC for a request that never presented a bearer token.
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('rejection is uniform', () => {
  it('answers 401 with no detail and no field', () => {
    const { context } = contextWith(undefined);

    try {
      new AccessTokenGuard(acceptingVerifier).canActivate(context);
      expect.unreachable();
    } catch (error) {
      const { status, body } = problem(error);

      expect(status).toBe(401);
      expect(body).toEqual({ type: 'about:blank', title: 'Unauthorized', status: 401 });
    }
  });

  it('produces byte-for-byte the same body for absent, expired and tampered', () => {
    // The acceptance criterion, as an assertion. The verifier already
    // refuses to say which failure it was; this proves the guard does not
    // reintroduce the difference on its way out.
    const bodies = [
      // Absent never reaches the verifier at all, so it is the case most
      // likely to answer differently from the other two.
      rejectionBody(acceptingVerifier, undefined),
      rejectionBody(acceptingVerifier, 'Basic dXNlcjpwYXNz'),
      rejectionBody(rejectingVerifier, 'Bearer expired.token.here'),
      rejectionBody(rejectingVerifier, 'Bearer tampered.token.here'),
    ];

    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toBe('accepted');
  });
});

function rejectionBody(verifier: { verify: () => VerifiedAccessToken }, header?: string): string {
  const { context } = contextWith(header);
  try {
    new AccessTokenGuard(verifier).canActivate(context);
    return 'accepted';
  } catch (error) {
    return JSON.stringify(problem(error));
  }
}

describe('WWW-Authenticate', () => {
  it.each([
    ['an absent header', undefined],
    ['a token the verifier refuses', 'Bearer a.b.c'],
  ])('is set, and bare, for %s', (_label, header) => {
    const verifier = header === undefined ? acceptingVerifier : rejectingVerifier;
    const { context, setHeader } = contextWith(header);

    expect(() => new AccessTokenGuard(verifier).canActivate(context)).toThrow();

    // RFC 7235 requires a 401 to say how to authenticate. RFC 6750 defines
    // error="invalid_token" / error="expired_token" parameters for this
    // header — sending either would put back exactly the distinction the
    // uniform body exists to withhold.
    expect(setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
    expect(setHeader.mock.calls[0]?.[1]).toBe('Bearer');
  });
});

describe('principalOf', () => {
  it('hands back what the guard proved', () => {
    const { context, request } = contextWith('Bearer a.b.c');
    new AccessTokenGuard(acceptingVerifier).canActivate(context);

    expect(principalOf(context)).toEqual(PRINCIPAL);
    expect(request.principal).toEqual(PRINCIPAL);
  });

  it('throws a plain Error, not a 401, when no guard ran', () => {
    // 500 is the right answer: the request was never checked, and the fault
    // is ours. A 401 would look like a working authentication failure and
    // hide the missing guard — which is the bug that lets an unchecked
    // request reach a handler.
    const { context } = contextWith('Bearer a.b.c');

    expect(() => principalOf(context)).toThrow(/without AccessTokenGuard/);
    expect(() => principalOf(context)).not.toThrow(ProblemDetailsException);
  });
});
