import { Module } from '@nestjs/common';

import { AuditModule } from '../../audit/audit.module';
import { NotificationPersistenceModule } from '../../notification/persistence/notification-persistence.module';
import { OperationPersistenceModule } from '../../operation/persistence/operation-persistence.module';
import { OperationFinalizer } from '../../operation/finalizer/operation-finalizer.service';
import { TransactionPersistenceModule } from '../persistence/transaction-persistence.module';
import { RpcModule } from '../rpc/rpc.module';
import { ConfirmationService } from './confirmation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';

/** TASK-11: judges chain state (`ConfirmationService`), applies the resulting transition
 * (`OperationFinalizer`), and the background scheduler that drives both across every in-flight
 * Operation (`ReconciliationScheduler`). */
@Module({
  imports: [
    TransactionPersistenceModule,
    OperationPersistenceModule,
    RpcModule,
    NotificationPersistenceModule,
    AuditModule,
  ],
  providers: [ConfirmationService, OperationFinalizer, ReconciliationScheduler],
  exports: [ConfirmationService, OperationFinalizer],
})
export class ConfirmationModule {}
