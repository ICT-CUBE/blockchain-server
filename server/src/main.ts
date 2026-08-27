import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';

async function bootstrap(): Promise<void> {
  // rawBody: true so HmacGuard can hash exactly the bytes the sender signed, not a re-serialized
  // JSON.stringify of the parsed body (TASK-06 §12 risk: "양 서버의 JSON 직렬화 차이로 서명 불일치").
  const app = await NestFactory.create(AppModule, { rawBody: true });
  const config = app.get(AppConfigService);
  await app.listen(config.port);
}

void bootstrap();
