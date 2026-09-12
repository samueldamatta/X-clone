import { Module } from '@nestjs/common';
import type { GatewayConfig } from './infrastructure/config/env';
import { IdentityGrpcClient } from './infrastructure/identity/identity.grpc-client';
import { Hs256AccessTokenVerifier } from './infrastructure/security/hs256-access-token-verifier';
import { AccessTokenGuard } from './presentation/http/access-token.guard';
import { AuthController } from './presentation/http/auth.controller';
import { HealthController } from './presentation/http/health.controller';
import { UsersController } from './presentation/http/users.controller';

/**
 * Composition root, mirroring the Identity service's: a factory rather than
 * a decorated class, so configuration is passed in as an argument instead
 * of being read from process.env deep inside a provider.
 */
export function buildAppModule(config: GatewayConfig) {
  @Module({
    controllers: [HealthController, AuthController, UsersController],
    providers: [
      {
        provide: IdentityGrpcClient,
        useFactory: () => new IdentityGrpcClient(config.identityGrpcUrl),
      },
      {
        /**
         * Built once, at boot, and shared. Constructing it here means a
         * secret too short for HS256 fails while the module is being built
         * — before the HTTP server binds — rather than on the first
         * authenticated request of the day. Identity's issuer is wired the
         * same way, for the same reason.
         */
        provide: Hs256AccessTokenVerifier,
        useFactory: () => new Hs256AccessTokenVerifier(config.jwtSecret),
      },
      /**
       * Registered as a provider, not applied globally with APP_GUARD.
       *
       * A global guard would protect every route by default and need an
       * opt-out on each public one, which is the safer default in most
       * systems. It is the wrong default here: `GET /v1/users/{handle}`
       * and the whole of `/v1/auth` are public *by design*, and most of
       * what this Gateway will grow — timelines, tweet reads — is public
       * too. A decorator on the routes that need it keeps the requirement
       * visible at the route, instead of as an exception list somewhere
       * else. The cost is real and worth naming: forgetting
       * `@UseGuards(AccessTokenGuard)` on a new authenticated route fails
       * open, and nothing but a test would catch it.
       */
      AccessTokenGuard,
    ],
  })
  class AppModule {}

  return AppModule;
}
