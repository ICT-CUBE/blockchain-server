import path from 'node:path';

import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';

import { AppConfigService } from './app-config.service';

// `<blockchain-root>/.env` is the single source of truth (see `.env.example` at the repo root).
// Resolved relative to this file rather than `process.cwd()` so it is found the same way whether
// the process is started from the repo root, from `server/` directly, or via the Docker image
// (which instead injects env vars directly, making this path simply not exist — harmless, since
// `envFilePath` entries that don't exist are silently skipped by dotenv). `.env` at `process.cwd()`
// remains a fallback for anyone running the compiled server from an unexpected directory.
const REPO_ROOT_ENV_FILE = path.join(__dirname, '..', '..', '..', '..', '.env');

// Global: AppConfigService is a fail-fast singleton every domain module needs (HMAC keys, JWT
// config, DB, contract deployment). Making every consumer explicitly re-import ConfigModule would
// just be ceremony around a config service, not a real module boundary worth enforcing.
@Global()
@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [REPO_ROOT_ENV_FILE, '.env'],
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class ConfigModule {}
