import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { sendProblemDetails } from './problem-details.render';

/**
 * Renders every uncaught exception as RFC 9457 `application/problem+json`.
 * Registered once, globally, in a service's bootstrap — see docs/04-api-contracts.md.
 *
 * The decisions live in problem-details.render.ts, because a Nest filter is
 * not the only thing that needs them: an Express body-parser failure never
 * reaches a filter at all, and is rendered by calling sendProblemDetails
 * directly from an error-handling middleware.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    sendProblemDetails(host.switchToHttp().getResponse<Response>(), exception);
  }
}
