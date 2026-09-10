import { HttpException, HttpStatus } from '@nestjs/common';
import { ProblemDetailsException } from './problem-details.exception';
import type { ProblemDetailsBody } from './problem-details.exception';
import { reasonPhrase } from './reason-phrases';

/**
 * Structural, rather than Express's `Response`: this is also called from an
 * Express error-handling middleware, which runs outside Nest entirely, and
 * typing it this narrowly documents exactly how little is needed.
 */
export interface ProblemDetailsResponse {
  status(code: number): ProblemDetailsResponse;
  contentType(type: string): ProblemDetailsResponse;
  send(body: ProblemDetailsBody): unknown;
}

/**
 * Written here rather than taken from the thrown error, which would quote
 * the caller's bytes back at them. Fixed strings: same problem, same words,
 * every time.
 */
const MIDDLEWARE_DETAILS: Record<number, string> = {
  400: 'the request body could not be parsed',
  413: 'the request body is too large',
  415: 'the request content type is not supported',
};

/**
 * Every uncaught exception, as an RFC 9457 body. Three cases, in descending
 * order of how much the exception is trusted:
 *
 * 1. A ProblemDetailsException carries its own shape. We wrote it, so all
 *    of it is safe to send.
 * 2. Any other HttpException (Nest's built-ins, e.g. from a pipe) keeps its
 *    status and message, but gets a stable title.
 * 3. Something thrown by middleware below Nest — the Express body parser is
 *    the one that matters — is honoured for its status only. Its message
 *    was written by a parser, from the caller's own bytes.
 *
 * Anything left is a bug, not a client error: 500, with nothing in it.
 */
export function toProblemDetailsBody(exception: unknown): ProblemDetailsBody {
  if (exception instanceof ProblemDetailsException) {
    return exception.toBody();
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const response = exception.getResponse();
    const detail = typeof response === 'string' ? response : exception.message;

    return { type: 'about:blank', title: reasonPhrase(status), status, detail };
  }

  const middlewareStatus = clientErrorStatusOf(exception);
  if (middlewareStatus !== undefined) {
    const detail = MIDDLEWARE_DETAILS[middlewareStatus];

    return {
      type: 'about:blank',
      title: reasonPhrase(middlewareStatus),
      status: middlewareStatus,
      ...(detail !== undefined && { detail }),
    };
  }

  return {
    type: 'about:blank',
    title: 'Internal Server Error',
    status: HttpStatus.INTERNAL_SERVER_ERROR,
  };
}

/** Renders the body onto a response, with the media type RFC 9457 requires. */
export function sendProblemDetails(response: ProblemDetailsResponse, exception: unknown): void {
  const body = toProblemDetailsBody(exception);

  response.status(body.status).contentType('application/problem+json').send(body);
}

/**
 * Express and everything built on it throw `http-errors` objects, which
 * carry the intended status on `.status`/`.statusCode`. Without this, a
 * body larger than the parser's limit — the caller's doing, and a 413 —
 * became a 500, which is a page at 3am for a request that was merely big.
 *
 * Only 4xx is honoured. A middleware claiming 5xx is claiming we are
 * broken, and that path already says so without quoting anything.
 */
function clientErrorStatusOf(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) {
    return undefined;
  }

  const status = 'status' in exception ? exception.status : undefined;
  const statusCode = 'statusCode' in exception ? exception.statusCode : undefined;
  const candidate = typeof status === 'number' ? status : statusCode;

  if (typeof candidate !== 'number' || candidate < 400 || candidate >= 500) {
    return undefined;
  }
  return candidate;
}
