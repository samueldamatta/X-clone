import { Controller, Get } from '@nestjs/common';

/**
 * Liveness, not readiness: it answers "is this process still able to serve
 * a request", and deliberately does NOT call Identity.
 *
 * A health check that reaches downstream turns one slow dependency into a
 * fleet-wide outage: Identity gets slow, every Gateway's check times out,
 * the orchestrator marks every Gateway unhealthy and restarts them all —
 * removing the only thing that could still have served the reads that do
 * not touch Identity at all.
 *
 * Unversioned on purpose. `/v1/...` is the public contract clients depend
 * on; this is for the compose healthcheck and, in Phase 11, for kubelet.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string } {
    return { status: 'ok' };
  }
}
