import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { MintModule } from './domains/nft/mint/mint.module';
import { OperationsHttpModule } from './domains/operation/http/operations-http.module';
import { WalletModule } from './domains/wallet/wallet.module';
import { ConfigModule } from './shared/config/config.module';
import { DatabaseModule } from './shared/database/database.module';
import { HealthModule } from './shared/health/health.module';
import { ApiExceptionFilter } from './shared/http/api-exception.filter';
import { RequestIdMiddleware } from './shared/http/request-id.middleware';

@Module({
  imports: [ConfigModule, DatabaseModule, HealthModule, MintModule, OperationsHttpModule, WalletModule],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
