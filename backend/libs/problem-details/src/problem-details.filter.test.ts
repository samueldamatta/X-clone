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

  it('adapts a plain Nest HttpException', () => {
    const filter = new ProblemDetailsFilter();
    const response = fakeResponse();

    filter.catch(new BadRequestException('bad input'), hostWith(response));

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.send).toHaveBeenCalledWith({
      type: 'about:blank',
      title: 'bad input',
      status: 400,
      detail: 'bad input',
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
