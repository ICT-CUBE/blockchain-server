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

  get hmacInbound(): AppConfig['hmacInbound'] {
    return this.config.hmacInbound;
  }

  get approvalJwt(): AppConfig['approvalJwt'] {
    return this.config.approvalJwt;
  }

  get web3Auth(): AppConfig['web3Auth'] {
    return this.config.web3Auth;
  }

  get submission(): AppConfig['submission'] {
    return this.config.submission;
  }

  get confirmation(): AppConfig['confirmation'] {
    return this.config.confirmation;
  }

  get ownerConsent(): AppConfig['ownerConsent'] {
    return this.config.ownerConsent;
  }

  get notification(): AppConfig['notification'] {
    return this.config.notification;
  }

  get metadata(): AppConfig['metadata'] {
    return this.config.metadata;
  }

  get logging(): AppConfig['logging'] {
    return this.config.logging;
  }

  get audit(): AppConfig['audit'] {
    return this.config.audit;
  }

  get hmacOperator(): AppConfig['hmacOperator'] {
    return this.config.hmacOperator;
  }
}
