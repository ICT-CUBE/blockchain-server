import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { OperationPersistenceModule } from '../operation/persistence/operation-persistence.module';
import { NonceCoordinator } from './nonce/nonce-coordinator.service';
import { TransactionPersistenceModule } from './persistence/transaction-persistence.module';
import { RpcModule } from './rpc/rpc.module';
import { SystemSignerService } from './signing/system-signer.service';
import { PendingMonitorWorker } from './submission/pending-monitor.worker';
import { SignedAttemptRecoveryWorker } from './submission/signed-attempt-recovery.worker';
import { TRANSACTION_SUBMISSION_PORT } from './submission/transaction-submission.port';
import { TransactionSubmissionService } from './submission/transaction-submission.service';

/**
 * TASK-10: everything Mint/Transfer/Withdrawal/Reentry/External-Resale workers need to get a
 * transaction onto the chain, plus the two background workers that make submission resilient to
 * crashes and slow confirmations (recovery re-broadcast, RBF). `TransactionSubmissionService` is
 * exported both under its own class (workers here use it directly) and under
 * `TRANSACTION_SUBMISSION_PORT` (what TASK-07+ domain workers depend on, never the concrete class).
 */
@Module({
  imports: [TransactionPersistenceModule, OperationPersistenceModule, RpcModule, AuditModule],
  providers: [
    SystemSignerService,
    NonceCoordinator,
    TransactionSubmissionService,
    { provide: TRANSACTION_SUBMISSION_PORT, useExisting: TransactionSubmissionService },
    SignedAttemptRecoveryWorker,
    PendingMonitorWorker,
  ],
  exports: [RpcModule, SystemSignerService, TransactionSubmissionService, TRANSACTION_SUBMISSION_PORT],
})
export class TransactionSubmissionModule {}
