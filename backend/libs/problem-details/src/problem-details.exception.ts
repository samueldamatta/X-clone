import { HttpException } from '@nestjs/common';

export interface ProblemDetailsBody {
  /** A URI identifying the problem type. `about:blank` when there is no more specific one. */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /**
   * RFC 9457 extension member: the request field that caused the failure.
   * Every validation error in this system rejects exactly one field, so a
   * single name is enough — see docs/04-api-contracts.md.
   */
  field?: string;
}

export interface ProblemDetailsInit {
  status: number;
  title: string;
  detail?: string;
  type?: string;
  instance?: string;
  field?: string;
}

/**
 * Thrown from a controller (or from a filter translating a lower-layer
 * error) to produce an RFC 9457 `application/problem+json` response.
 * Extends HttpException so Nest's ordinary exception pipeline still applies
 * — this is a shape, not a parallel error-handling mechanism.
 */
export class ProblemDetailsException extends HttpException {
  readonly problemType: string;
  readonly detail: string | undefined;
  readonly instance: string | undefined;
  readonly field: string | undefined;

  constructor(init: ProblemDetailsInit) {
    super(init.title, init.status);
    this.problemType = init.type ?? 'about:blank';
    this.detail = init.detail;
    this.instance = init.instance;
    this.field = init.field;
  }

  toBody(): ProblemDetailsBody {
    return {
      type: this.problemType,
      title: this.message,
      status: this.getStatus(),
      ...(this.detail !== undefined && { detail: this.detail }),
      ...(this.instance !== undefined && { instance: this.instance }),
      ...(this.field !== undefined && { field: this.field }),
    };
  }
}
