import { Injectable } from '@nestjs/common';

import { loadConfig, type AppConfig } from './app-config';

/** Thin, strongly-typed wrapper around `loadConfig()`. Loaded once per process at DI construction
 * time (by which point `@nestjs/config`'s `ConfigModule.forRoot` has already applied `.env`), so an
 * invalid or incomplete environment fails application bootstrap instead of failing on first use. */
@Injectable()
export class AppConfigService {
  private readonly config: AppConfig;

  constructor() {
    this.config = loadConfig();
  }

  get nodeEnv(): AppConfig['nodeEnv'] {
    return this.config.nodeEnv;
  }

  get port(): AppConfig['port'] {
    return this.config.port;
  }

  get network(): AppConfig['network'] {
    return this.config.network;
  }

  get cubeNft(): AppConfig['cubeNft'] {
    return this.config.cubeNft;
  }

  get database(): AppConfig['database'] {
    return this.config.database;
  }
}
