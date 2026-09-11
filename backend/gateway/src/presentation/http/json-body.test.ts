import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { jsonBodyFailures } from './json-body';

function fakeResponse(headersSent: boolean) {
  const response = {
    headersSent,
    status: vi.fn(),
    contentType: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.contentType.mockReturnValue(response);
  return response;
}

function run(error: unknown, response: ReturnType<typeof fakeResponse>) {
  const next = vi.fn();
  jsonBodyFailures(error, {} as Request, response as unknown as Response, next);
  return next;
}

describe('jsonBodyFailures', () => {
  it('renders a parse failure without quoting the body back', () => {
    // Exactly what Express throws: a SyntaxError decorated by http-errors,
    // whose message contains whatever the caller sent.
    const parseFailure = Object.assign(
      new SyntaxError('Unexpected token in JSON: {"password":"hunter2"'),
      { status: 400, type: 'entity.parse.failed' },
    );
    const response = fakeResponse(false);

    run(parseFailure, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.contentType).toHaveBeenCalledWith('application/problem+json');
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'the request body could not be parsed',
    });
    expect(JSON.stringify(response.send.mock.calls)).not.toContain('hunter2');
  });

  it('reports an oversized body as 413 rather than as our failure', () => {
    const response = fakeResponse(false);

    run(Object.assign(new Error('request entity too large'), { status: 413 }), response);

    expect(response.status).toHaveBeenCalledWith(413);
  });

  it('hands the error on when the response has already started', () => {
    // Writing a second set of headers throws ERR_HTTP_HEADERS_SENT and
    // takes down the request that was, until then, succeeding. Express's
    // own default handler knows how to abort a half-sent response.
    const response = fakeResponse(true);

    const next = run(new Error('too late'), response);

    expect(next).toHaveBeenCalledOnce();
    expect(response.send).not.toHaveBeenCalled();
  });
});
