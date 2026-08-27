import { Module } from '@nestjs/common';

import { ApprovalJwtAuthModule } from '../../../shared/auth/approval-jwt/approval-jwt-auth.module';
import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { OperationIntakeModule } from '../../../shared/idempotency/operation-intake.module';
import { AuditModule } from '../../audit/audit.module';
import { OperationPersistenceModule } from '../../operation/persistence/operation-persistence.module';
import { TransactionPersistenceModule } from '../../transaction/persistence/transaction-persistence.module';
import { RpcModule } from '../../transaction/rpc/rpc.module';
import { TransactionSubmissionModule } from '../../transaction/transaction-submission.module';
import { WalletModule } from '../../wallet/wallet.module';
import { TransferApplication } from './transfer.application';
import { TransferController } from './transfer.controller';
import { TransferWorker } from './transfer.worker';

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
    AuditModule,
  ],
  controllers: [TransferController],
  providers: [TransferApplication, TransferWorker],
})
export class TransferModule {}
