import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../shared/auth/hmac/hmac-auth.module';
import { AuditWriter } from './application/audit-writer';
import { AuditController } from './http/audit.controller';
import { AuditPersistenceModule } from './persistence/audit-persistence.module';

/** Every domain that needs to record a security/audit/failure event (TASK-14) imports this module
 * and injects `AuditWriter` — never the raw `AuditRecord`/`FailureRecord` repositories directly,
 * so the allowlist/redaction discipline in `AuditWriter` can't be bypassed. Also hosts the
 * operator-only read/resolve endpoints (`AuditController`) built on top of the same persistence
 * module. */
@Module({
  imports: [AuditPersistenceModule, HmacAuthModule],
  controllers: [AuditController],
  providers: [AuditWriter],
  exports: [AuditWriter],
})
export class AuditModule {}
