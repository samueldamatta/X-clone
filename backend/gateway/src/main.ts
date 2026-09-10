import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ProblemDetailsFilter } from '@x-clone/problem-details';
import { buildAppModule } from './app.module';
import { loadConfig } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create(buildAppModule());

  // Registered before the first route exists, not after the first endpoint
  // needs it. `@Catch()` with no argument means it catches everything, so
  // no response can escape in Nest's default `{statusCode, message, error}`
  // shape — see docs/04-api-contracts.md.
  app.useGlobalFilters(new ProblemDetailsFilter());

  // 0.0.0.0, not the default localhost: inside a container, a server bound
  // to the loopback interface is unreachable from the published port.
  await app.listen(config.httpPort, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('gateway failed to start', error);
  process.exit(1);
});
