import { Module } from '@nestjs/common';
import type { GatewayConfig } from './infrastructure/config/env';
import { IdentityGrpcClient } from './infrastructure/identity/identity.grpc-client';
import { AuthController } from './presentation/http/auth.controller';
import { HealthController } from './presentation/http/health.controller';

/**
 * Composition root, mirroring the Identity service's: a factory rather than
 * a decorated class, so configuration is passed in as an argument instead
 * of being read from process.env deep inside a provider.
 */
export function buildAppModule(config: GatewayConfig) {
  @Module({
    controllers: [HealthController, AuthController],
    providers: [
      {
        provide: IdentityGrpcClient,
        useFactory: () => new IdentityGrpcClient(config.identityGrpcUrl),
      },
    ],
  })
  class AppModule {}

  return AppModule;
}
