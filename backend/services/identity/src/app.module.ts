import { Module } from '@nestjs/common';
import { RegisterUserUseCase } from './application/register-user.use-case';
import type { IdentityConfig } from './infrastructure/config/env';
import { SnowflakeIdGenerator } from './infrastructure/ids/snowflake-id-generator';
import { createDatabase } from './infrastructure/persistence/db';
import { DrizzleUserRepository } from './infrastructure/persistence/drizzle-user.repository';
import { Argon2PasswordHasher } from './infrastructure/security/argon2-password-hasher';
import { IdentityGrpcController } from './presentation/grpc/identity.grpc-controller';

/**
 * Composition root. Wiring lives here, once, rather than each adapter
 * reaching for a global — the point of the ports in domain/ is that
 * everything above this file only ever sees them.
 */
export function buildAppModule(config: IdentityConfig) {
  const { db } = createDatabase(config.databaseUrl);

  @Module({
    controllers: [IdentityGrpcController],
    providers: [
      {
        provide: RegisterUserUseCase,
        useFactory: () =>
          new RegisterUserUseCase(
            new DrizzleUserRepository(db),
            new Argon2PasswordHasher(),
            new SnowflakeIdGenerator(config.snowflakeNodeId),
          ),
      },
    ],
  })
  class AppModule {}

  return AppModule;
}
