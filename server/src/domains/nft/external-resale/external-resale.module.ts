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
import { ExternalResaleApplication } from './external-resale.application';
import { ExternalResaleController } from './external-resale.controller';
import { ExternalResaleWorker } from './external-resale.worker';

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
  controllers: [ExternalResaleController],
  providers: [ExternalResaleApplication, ExternalResaleWorker],
})
export class ExternalResaleModule {}
