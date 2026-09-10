import { sendProblemDetails } from '@x-clone/problem-details';
import { json, type ErrorRequestHandler, type RequestHandler } from 'express';

/**
 * The same value Express defaults to, stated out loud. A limit that only
 * exists as a library default is a limit nobody knows they have — and this
 * is the number that decides how large a request has to be before it is
 * refused instead of parsed.
 */
export const JSON_BODY_LIMIT = '100kb';

export const jsonBody: RequestHandler = json({ limit: JSON_BODY_LIMIT });

/**
 * The reason the Gateway registers its own body parser rather than using
 * Nest's built-in one.
 *
 * A body-parser failure happens in Express middleware, before Nest's
 * request pipeline exists, so no exception filter ever sees it. Nest's
 * workaround is to catch it later and rethrow it as BadRequestException
 * carrying the parser's message — and V8's JSON errors quote the input:
 *
 *     Unexpected token '"', ""nope"" is not valid JSON
 *
 * A malformed body containing a password would put that password in the
 * response, and from there into every access log that records one. Nest
 * drops the original error's `cause`, so by the time a filter runs there
 * is no way left to tell that message apart from one we wrote ourselves.
 *
 * Handling it here keeps the raw error intact, and sendProblemDetails
 * already knows to trust an http-errors object for its status and nothing
 * else.
 */
export const jsonBodyFailures: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  sendProblemDetails(response, error);
};
