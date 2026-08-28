import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';

import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';
import { structuredLogLevelFromEnv, StructuredLogger } from './shared/logging/structured-logger';

/** JSON body limit. Only `POST /internal/v1/metadata` carries anything sizeable (a base64 image
 * bounded by `METADATA_IMAGE_MAX_BYTES`, 2 MiB by default → ~2.7 MiB encoded); every other body is
 * a few hundred bytes. Kept well under anything that could be used to exhaust memory. */
const JSON_BODY_LIMIT = '4mb';

async function bootstrap(): Promise<void> {
  // rawBody: true so HmacGuard can hash exactly the bytes the sender signed, not a re-serialized
  // JSON.stringify of the parsed body (TASK-06 §12 risk: "양 서버의 JSON 직렬화 차이로 서명 불일치").
  // bodyParser: false + useBodyParser lets the limit be set while keeping rawBody capture.
  // Structured (one-JSON-line-per-call) logging from the very first bootstrap log, not only after
  // DI is up — TASK-14 §8's "구조화 logger" setting is read straight from the environment for the
  // same reason `RAW_TX_ENCRYPTION_KEY` etc. are: it must be in effect before AppConfigService could
  // ever throw a validation error that itself needs to be logged.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
    logger: new StructuredLogger(structuredLogLevelFromEnv()),
  });
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

void bootstrap();
