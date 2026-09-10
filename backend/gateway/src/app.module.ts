import { Module } from '@nestjs/common';
import { HealthController } from './presentation/http/health.controller';

/**
 * Composition root, mirroring the Identity service's: a factory rather than
 * a decorated class, so configuration is passed in as an argument instead
 * of being read from process.env deep inside a provider.
 *
 * It takes no argument yet because nothing below it needs one. The Identity
 * gRPC client (next commit) is what gives it one.
 */
export function buildAppModule() {
  @Module({
    controllers: [HealthController],
  })
  class AppModule {}

  return AppModule;
}
