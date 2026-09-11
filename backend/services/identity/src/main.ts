import 'reflect-metadata';
import { identityProtoPath, IDENTITY_PACKAGE_NAME } from '@x-clone/proto';
import { NestFactory } from '@nestjs/core';
import { Transport, type MicroserviceOptions } from '@nestjs/microservices';
import { buildAppModule } from './app.module';
import { loadConfig } from './infrastructure/config/env';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const AppModule = buildAppModule(config);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(AppModule, {
    transport: Transport.GRPC,
    options: {
      package: IDENTITY_PACKAGE_NAME,
      protoPath: identityProtoPath(),
      url: config.grpcUrl,
    },
  });

  await app.listen();
}

bootstrap().catch((error: unknown) => {
  console.error('identity failed to start', error);
  process.exit(1);
});
