/**
 * RFC 9457 is specific about `title`: it is "a short, human-readable summary
 * of the problem type", and it "SHOULD NOT change from occurrence to
 * occurrence of the problem". Clients group and count errors by it.
 *
 * That rules out using an exception's own message, which is written per
 * occurrence — and, for anything thrown by a parser, is written from the
 * input the caller sent. `Unexpected token '"' ... is not valid JSON` fails
 * both tests at once: unstable, and quoting the request body back.
 */
const REASON_PHRASES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * The line between "you got it wrong" and "we got it wrong", which is also the
 * line where forwarding an upstream message stops being helpful and starts
 * being a leak.
 *
 * Typed `number` rather than left as the HttpStatus enum member on purpose:
 * `response.getStatus()` returns a plain number, and comparing the two trips
 * @typescript-eslint/no-unsafe-enum-comparison. Naming it once here is what
 * keeps every caller from rediscovering that.
 */
export const FIRST_SERVER_ERROR_STATUS: number = 500;

/**
 * The stable title for a status code. An unlisted code falls back to the
 * class it belongs to rather than to a made-up phrase.
 */
export function reasonPhrase(status: number): string {
  const phrase = REASON_PHRASES[status];
  if (phrase !== undefined) {
    return phrase;
  }
  return status >= FIRST_SERVER_ERROR_STATUS ? 'Internal Server Error' : 'Request Error';
}
