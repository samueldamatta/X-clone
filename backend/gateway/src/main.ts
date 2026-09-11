import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ProblemDetailsFilter } from '@x-clone/problem-details';
import { buildAppModule } from './app.module';
import { loadConfig } from './infrastructure/config/env';
import { jsonBody, jsonBodyFailures } from './presentation/http/json-body';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  // bodyParser: false, then the same parser registered by hand — see
  // json-body.ts. Nest's built-in one rethrows a parse failure as a
  // BadRequestException carrying V8's message, which quotes the request
  // body back at the caller.
  const app = await NestFactory.create(buildAppModule(config), { bodyParser: false });

  app.use(jsonBody);
  app.use(jsonBodyFailures);

  // Registered before the first route exists, not after the first endpoint
  // needs it. `@Catch()` with no argument means it catches everything, so
  // no response can escape in Nest's default `{statusCode, message, error}`
  // shape — see docs/04-api-contracts.md.
  app.useGlobalFilters(new ProblemDetailsFilter());
  // Without this, Nest never calls onApplicationShutdown — the gRPC channel
  // is never closed, its keepalive timers hold the event loop open, and a
  // `docker stop` ends in SIGKILL instead of a clean exit.
  app.enableShutdownHooks();

  // 0.0.0.0, not the default localhost: inside a container, a server bound
  // to the loopback interface is unreachable from the published port.
  await app.listen(config.httpPort, '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('gateway failed to start', error);
  process.exit(1);
});
