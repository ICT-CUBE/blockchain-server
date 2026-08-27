import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';
import { structuredLogLevelFromEnv, StructuredLogger } from './shared/logging/structured-logger';

async function bootstrap(): Promise<void> {
  // rawBody: true so HmacGuard can hash exactly the bytes the sender signed, not a re-serialized
  // JSON.stringify of the parsed body (TASK-06 §12 risk: "양 서버의 JSON 직렬화 차이로 서명 불일치").
  // Structured (one-JSON-line-per-call) logging from the very first bootstrap log, not only after
  // DI is up — TASK-14 §8's "구조화 logger" setting is read straight from the environment for the
  // same reason `RAW_TX_ENCRYPTION_KEY` etc. are: it must be in effect before AppConfigService could
  // ever throw a validation error that itself needs to be logged.
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: new StructuredLogger(structuredLogLevelFromEnv()),
  });
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

void bootstrap();
