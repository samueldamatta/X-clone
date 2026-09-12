import { Module } from '@nestjs/common';
import { LoginUseCase } from './application/login.use-case';
import { RegisterUserUseCase } from './application/register-user.use-case';
import { systemClock } from './domain/ports/clock';
import type { IdentityConfig } from './infrastructure/config/env';
import { SnowflakeIdGenerator } from './infrastructure/ids/snowflake-id-generator';
import { createDatabase } from './infrastructure/persistence/db';
import { DrizzleSessionRepository } from './infrastructure/persistence/drizzle-session.repository';
import { DrizzleUserRepository } from './infrastructure/persistence/drizzle-user.repository';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher';
import { Hs256AccessTokenIssuer } from './infrastructure/security/hs256-access-token-issuer';
import { RandomRefreshTokenFactory } from './infrastructure/security/random-refresh-token-factory';
import { IdentityGrpcController } from './presentation/grpc/identity.grpc-controller';

/**
 * Composition root. Wiring lives here, once, rather than each adapter
 * reaching for a global — the point of the ports in domain/ is that
 * everything above this file only ever sees them.
 */
export function buildAppModule(config: IdentityConfig) {
  const { db } = createDatabase(config.databaseUrl);

  // Built once, here, and shared by both use cases. The id generator in
  // particular must be a single instance: two SnowflakeIdGenerators with
  // the same node id can mint the same id in the same millisecond, which
  // is the one failure mode Snowflake has no defence against — see
  // docs/concepts/snowflake-ids.md.
  const users = new DrizzleUserRepository(db);
  const hasher = new Argon2PasswordHasher();
  const ids = new SnowflakeIdGenerator(config.snowflakeNodeId);

  // Constructed at boot rather than per request, so a secret too short for
  // HS256 fails here — before the gRPC server binds — instead of on the
  // first login of the day.
  const accessTokens = new Hs256AccessTokenIssuer(config.jwtSecret);

  @Module({
    controllers: [IdentityGrpcController],
    providers: [
      {
        provide: RegisterUserUseCase,
        useFactory: () => new RegisterUserUseCase(users, hasher, ids),
      },
      {
        provide: LoginUseCase,
        useFactory: () =>
          new LoginUseCase(
            users,
            new DrizzleSessionRepository(db),
            hasher,
            accessTokens,
            new RandomRefreshTokenFactory(),
            ids,
            systemClock,
            config.tokenLifetimes,
          ),
      },
    ],
  })
  class AppModule {}

  return AppModule;
}
