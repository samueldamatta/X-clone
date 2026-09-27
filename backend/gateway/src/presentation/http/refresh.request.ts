import { HttpStatus } from '@nestjs/common';
import { ProblemDetailsException, reasonPhrase } from '@x-clone/problem-details';

/** The public shape of POST /v1/auth/refresh. */
export interface RefreshBody {
  refreshToken: string;
}

/** Shape only: whether the token is real is Identity's question, answered with a 401. */
export function parseRefreshBody(body: unknown): RefreshBody {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw badRequest('expected a JSON object body');
  }

  const { refreshToken } = body as Record<string, unknown>;
  if (typeof refreshToken !== 'string') {
    // Never echoes the value: it may be the secret itself, one wrapper deep.
    throw badRequest(
      refreshToken === undefined ? 'is required' : 'must be a string',
      'refreshToken',
    );
  }

  return { refreshToken };
}

function badRequest(detail: string, field?: string): ProblemDetailsException {
  return new ProblemDetailsException({
    status: HttpStatus.BAD_REQUEST,
    title: reasonPhrase(HttpStatus.BAD_REQUEST),
    detail,
    ...(field !== undefined && { field }),
  });
}
