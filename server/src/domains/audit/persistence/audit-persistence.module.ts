import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuditRecord } from './audit-record.entity';
import { FailureRecord } from './failure-record.entity';

/** Exposes plain TypeORM repositories only — no custom port. Neither entity needs
 * concurrency/atomicity semantics beyond a single insert, so per TASK-04 §7 they are injected
 * directly (`@InjectRepository`) wherever a domain needs to write one. TASK-14 builds the
 * `AuditWriter` allowlist/redaction layer on top of this. */
@Module({
  imports: [TypeOrmModule.forFeature([FailureRecord, AuditRecord])],
  exports: [TypeOrmModule],
})
export class AuditPersistenceModule {}
