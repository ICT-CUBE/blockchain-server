import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { redactSensitiveKeys } from '../../../shared/logging/sensitive-key-redactor';
import { AuditCategory, AuditRecord } from '../persistence/audit-record.entity';
import { FailureCode, FailureRecord } from '../persistence/failure-record.entity';

export interface WriteAuditInput {
  category: AuditCategory;
  /** Who did it — a userId, service account name, or "SYSTEM". Never a secret/token. */
  actor: string;
  /** A stable short code, e.g. "MINT_ACCEPTED", "GRANT_ROLE". */
  action: string;
  target?: string | null;
  requestId?: string | null;
  operationId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface WriteFailureInput {
  code: FailureCode;
  operationId?: string | null;
  attemptId?: string | null;
  notificationId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * TASK-14 §4/§5: the one place every domain calls to persist a security/audit/failure event. Takes
 * only explicit, named fields (the "allowlist" half of "allowlist/redaction" — a caller can't
 * accidentally dump an entire raw payload here, the method signature won't accept one) and passes
 * `details` through `redactSensitiveKeys` as a second safety net before it ever reaches the DB.
 * Deliberately not a generic Domain Event/EventBus (TASK-14 §4 rules that out explicitly) — every
 * call site below is an explicit, intentional call from an Application Service or worker.
 */
@Injectable()
export class AuditWriter {
  private readonly logger = new Logger(AuditWriter.name);

  constructor(
    @InjectRepository(AuditRecord) private readonly auditRepository: Repository<AuditRecord>,
    @InjectRepository(FailureRecord) private readonly failureRepository: Repository<FailureRecord>,
  ) {}

  async writeAudit(input: WriteAuditInput): Promise<AuditRecord> {
    const entity = this.auditRepository.create({
      id: randomUUID(),
      category: input.category,
      actor: input.actor,
      action: input.action,
      target: input.target ?? null,
      requestId: input.requestId ?? null,
      operationId: input.operationId ?? null,
      details: this.sanitize(input.details),
    });
    return this.auditRepository.save(entity);
  }

  async writeFailure(input: WriteFailureInput): Promise<FailureRecord> {
    const entity = this.failureRepository.create({
      id: randomUUID(),
      code: input.code,
      operationId: input.operationId ?? null,
      attemptId: input.attemptId ?? null,
      notificationId: input.notificationId ?? null,
      details: this.sanitize(input.details),
      resolvedAt: null,
      resolution: null,
    });
    return this.failureRepository.save(entity);
  }

  /** Same as `writeFailure`, but skips the insert if an unresolved record for the same
   * `(code, operationId)` already exists — keeps a still-ongoing condition a poller re-detects
   * every tick (e.g. an Operation still LONG_PENDING on the next reconciliation pass) from
   * spamming duplicate rows. A resolved prior record does not suppress a fresh one: if the same
   * condition recurs after being marked resolved, that is worth a new record. */
  async writeFailureOnce(input: WriteFailureInput): Promise<void> {
    if (!input.operationId) {
      await this.writeFailure(input);
      return;
    }
    const existing = await this.failureRepository.findOne({
      where: { code: input.code, operationId: input.operationId, resolvedAt: IsNull() },
    });
    if (existing) {
      return;
    }
    await this.writeFailure(input);
  }

  private sanitize(details: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!details) {
      return null;
    }
    const redactedPaths: string[] = [];
    const sanitized = redactSensitiveKeys(details, (path) => redactedPaths.push(path));
    if (redactedPaths.length > 0) {
      this.logger.warn(
        `AuditWriter redacted ${redactedPaths.length} sensitive-looking key(s) from details: ${redactedPaths.join(', ')}`,
      );
    }
    return sanitized as Record<string, unknown>;
  }
}
