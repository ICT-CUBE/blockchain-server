import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../shared/auth/hmac/hmac-auth.module';
import { OperationPersistenceModule } from '../operation/persistence/operation-persistence.module';
import { TransactionPersistenceModule } from '../transaction/persistence/transaction-persistence.module';
import { AuditWriter } from './application/audit-writer';
import { AuditController } from './http/audit.controller';
import { OperatorRecoveryController } from './http/operator-recovery.controller';
import { AuditPersistenceModule } from './persistence/audit-persistence.module';

/** Every domain that needs to record a security/audit/failure event (TASK-14) imports this module
 * and injects `AuditWriter` — never the raw `AuditRecord`/`FailureRecord` repositories directly,
 * so the allowlist/redaction discipline in `AuditWriter` can't be bypassed. Also hosts the
 * operator-only read/resolve endpoints (`AuditController`) and the limited REVIEW_REQUIRED recovery
 * endpoint (`OperatorRecoveryController`, 검증 D3) built on top of the same persistence module. */
@Module({
  imports: [AuditPersistenceModule, HmacAuthModule, OperationPersistenceModule, TransactionPersistenceModule],
  controllers: [AuditController, OperatorRecoveryController],
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
