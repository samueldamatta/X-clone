import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ProblemDetailsException } from './problem-details.exception';
import { ProblemDetailsFilter } from './problem-details.filter';

function hostWith(response: {
  status: ReturnType<typeof vi.fn>;
  contentType: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
}): ArgumentsHost {
  return {
    switchToHttp: () => ({
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
}

function fakeResponse() {
  const response = {
    status: vi.fn(),
    contentType: vi.fn(),
    send: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.contentType.mockReturnValue(response);
  return response;
}

describe('ProblemDetailsFilter', () => {
  it('renders a ProblemDetailsException as its own body', () => {
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();
    const exception = new ProblemDetailsException({
      status: 409,
      title: 'Handle taken',
      field: 'handle',
    });

    filter.catch(exception, hostWith(response));

    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.contentType).toHaveBeenCalledWith('application/problem+json');
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Handle taken',
      status: 409,
      field: 'handle',
    });
  });

  it('adapts a plain Nest HttpException, giving it a stable title', () => {
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(new BadRequestException('bad input'), hostWith(response));

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      // RFC 9457: the title names the problem type and should not vary per
      // occurrence. The message is specific to this one, so it is the detail.
      title: 'Bad Request',
      status: 400,
      detail: 'bad input',
    });
  });

  it('honours the status of an http-errors object thrown below Nest', () => {
    // What Express's body parser throws when the payload exceeds its limit.
    // Before this was handled, it fell through to 500 — an alert at 3am for
    // a request that was merely too big.
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(
      Object.assign(new Error('request entity too large'), { status: 413 }),
      hostWith(response),
    );

    expect(response.status).toHaveBeenCalledWith(413);
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Payload Too Large',
      status: 413,
      detail: 'the request body is too large',
    });
  });

  it('does not quote a parser message back at the caller', () => {
    // V8's JSON.parse errors embed the input: `Unexpected token '"',
    // ""nope"" is not valid JSON`. A malformed body containing a password
    // would put that password in the response, and from there into logs.
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(
      Object.assign(new SyntaxError('Unexpected token in JSON: {"password":"hunter2"'), {
        status: 400,
      }),
      hostWith(response),
    );

    expect(JSON.stringify(response.send.mock.calls[0])).not.toContain('hunter2');
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: 'the request body could not be parsed',
    });
  });

  it('refuses to let middleware claim a 5xx on its own terms', () => {
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(
      Object.assign(new Error('upstream socket closed at 10.0.1.7'), { status: 502 }),
      hostWith(response),
    );

    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
    });
  });

  it('turns anything else into a 500 with no leaked detail', () => {
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(new Error('a stack trace nobody outside should see'), hostWith(response));

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
    });
  });
});
