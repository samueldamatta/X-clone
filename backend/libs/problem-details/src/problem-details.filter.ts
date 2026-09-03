import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Response } from 'express';
import { ProblemDetailsException } from './problem-details.exception';
import type { ProblemDetailsBody } from './problem-details.exception';

/**
 * Renders every uncaught exception as RFC 9457 `application/problem+json`.
 * Registered once, globally, in a service's bootstrap — see docs/04-api-contracts.md.
 *
 * A ProblemDetailsException carries its own shape. Any other HttpException
 * (Nest's built-in ones, e.g. from a pipe) is adapted rather than dropped to
 * a bare Express error page. Anything that is not an HttpException at all is
 * a bug, not a client error, so it becomes a 500 with no leaked detail.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const body = this.toProblemDetails(exception);

    response.status(body.status).contentType('application/problem+json').send(body);
  }

  private toProblemDetails(exception: unknown): ProblemDetailsBody {
    if (exception instanceof ProblemDetailsException) {
      return exception.toBody();
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const detail = typeof response === 'string' ? response : exception.message;

      return { type: 'about:blank', title: exception.message, status, detail };
    }

    return {
      type: 'about:blank',
      title: 'Internal Server Error',
      status: HttpStatus.INTERNAL_SERVER_ERROR,
    };
  }
}
