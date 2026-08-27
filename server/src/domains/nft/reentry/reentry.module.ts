import { Module } from '@nestjs/common';

import { ApprovalJwtAuthModule } from '../../../shared/auth/approval-jwt/approval-jwt-auth.module';
import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { OperationIntakeModule } from '../../../shared/idempotency/operation-intake.module';
import { OperationPersistenceModule } from '../../operation/persistence/operation-persistence.module';
import { TransactionPersistenceModule } from '../../transaction/persistence/transaction-persistence.module';
import { RpcModule } from '../../transaction/rpc/rpc.module';
import { TransactionSubmissionModule } from '../../transaction/transaction-submission.module';
import { WalletModule } from '../../wallet/wallet.module';
import { ReentryApplication } from './reentry.application';
import { ReentryController } from './reentry.controller';
import { ReentryWorker } from './reentry.worker';

@Module({
  imports: [
    HmacAuthModule,
    ApprovalJwtAuthModule,
    OperationIntakeModule,
    OperationPersistenceModule,
    TransactionPersistenceModule,
    TransactionSubmissionModule,
    RpcModule,
    WalletModule,
  ],
  controllers: [ReentryController],
  providers: [ReentryApplication, ReentryWorker],
})
export class ReentryModule {}
