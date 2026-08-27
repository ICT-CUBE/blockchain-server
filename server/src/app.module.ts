import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { ExternalConsentChallengeModule } from './domains/nft/external-consent-challenge/external-consent-challenge.module';
import { ExternalResaleModule } from './domains/nft/external-resale/external-resale.module';
import { MintModule } from './domains/nft/mint/mint.module';
import { ReentryModule } from './domains/nft/reentry/reentry.module';
import { TransferModule } from './domains/nft/transfer/transfer.module';
import { WithdrawalModule } from './domains/nft/withdrawal/withdrawal.module';
import { OperationsHttpModule } from './domains/operation/http/operations-http.module';
import { ConfirmationModule } from './domains/transaction/confirmation/confirmation.module';
import { TransactionSubmissionModule } from './domains/transaction/transaction-submission.module';
import { WalletModule } from './domains/wallet/wallet.module';
import { ConfigModule } from './shared/config/config.module';
import { DatabaseModule } from './shared/database/database.module';
import { HealthModule } from './shared/health/health.module';
import { ApiExceptionFilter } from './shared/http/api-exception.filter';
import { RequestIdMiddleware } from './shared/http/request-id.middleware';

@Module({
  imports: [
    ConfigModule,
    DatabaseModule,
    HealthModule,
    TransactionSubmissionModule,
    ConfirmationModule,
    MintModule,
    TransferModule,
    WithdrawalModule,
    ReentryModule,
    ExternalResaleModule,
    ExternalConsentChallengeModule,
    OperationsHttpModule,
    WalletModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: ApiExceptionFilter }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
