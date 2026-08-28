import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { z } from 'zod';

import { OperatorHmacGuard } from '../../../shared/auth/hmac/operator-hmac.guard';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { ApiError } from '../../../shared/http/api-error';
import type { RequestWithId } from '../../../shared/http/request-id.middleware';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { Req } from '@nestjs/common';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { TransactionAttempt } from '../../transaction/persistence/transaction-attempt.entity';
import { AuditWriter } from '../application/audit-writer';
import { AuditCategory } from '../persistence/audit-record.entity';
import { FailureCode } from '../persistence/failure-record.entity';

const resolveReviewSchema = z
  .object({
    /** RELEASE_LOCK: give up on the Operation (→ FAILED) and free the token for new work.
     *  REQUEUE: put it back to REQUESTED so the worker retries — only allowed while nothing was
     *  ever signed for it (a stored external consent can then be re-submitted, or a fresh
     *  challenge/signature accepted after the lock is released). */
    action: z.enum(['RELEASE_LOCK', 'REQUEUE']),
    note: z.string().min(1).max(200),
    operator: z.string().min(1).max(128),
  })
  .strict();
type ResolveReviewBody = z.infer<typeof resolveReviewSchema>;

/** Attempt statuses that mean "a signed transaction for this Operation may still land on chain" —
 * while any exists, neither recovery action is safe (the lock is doing its job). */
const IN_FLIGHT_ATTEMPT_STATUSES = [TransactionAttemptStatus.SIGNED, TransactionAttemptStatus.BROADCAST];

export interface ResolveReviewResponse {
  operationId: string;
  previousStatus: OperationStatus;
  status: OperationStatus;
  lockReleased: boolean;
  action: ResolveReviewBody['action'];
}

/**
 * 검증 D3 §7: the *limited* operator recovery path for Operations stuck in REVIEW_REQUIRED —
 * deliberately not a generic admin API. Two narrow actions, both refused while a signed/broadcast
 * attempt is still in flight, both recorded as an ADMIN_ACTION audit record plus an
 * `OPERATOR_RESOLVED` failure record naming the operator and note. Gated by the operator HMAC key
 * scope, never the Backend integration key (TASK-14 §5).
 */
@Controller('internal/v1/audit/operations')
@UseGuards(OperatorHmacGuard)
export class OperatorRecoveryController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly auditWriter: AuditWriter,
  ) {}

  @Post(':id/resolve-review')
  @HttpCode(200)
  async resolveReview(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(new ZodValidationPipe(resolveReviewSchema)) body: ResolveReviewBody,
    @Req() request: RequestWithId,
  ): Promise<ResolveReviewResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }
    if (operation.status !== OperationStatus.REVIEW_REQUIRED) {
      throw new ApiError(
        'OPERATION_NOT_UNDER_REVIEW',
        `Operation ${id} is ${operation.status}, not REVIEW_REQUIRED`,
        409,
      );
    }

    const inFlight = await this.dataSource.getRepository(TransactionAttempt).count({
      where: { operationId: id, status: In(IN_FLIGHT_ATTEMPT_STATUSES) },
    });
    if (inFlight > 0) {
      throw new ApiError(
        'OPERATION_HAS_INFLIGHT_ATTEMPT',
        `Operation ${id} still has a signed/broadcast transaction attempt; wait for reconciliation before resolving`,
        409,
      );
    }

    if (body.action === 'REQUEUE') {
      const anyAttempt = await this.dataSource
        .getRepository(TransactionAttempt)
        .count({ where: { operationId: id } });
      if (anyAttempt > 0) {
        throw new ApiError(
          'OPERATION_ALREADY_SIGNED',
          `Operation ${id} already has transaction attempts and cannot be re-queued; use RELEASE_LOCK`,
          409,
        );
      }
    }

    const nextStatus = body.action === 'RELEASE_LOCK' ? OperationStatus.FAILED : OperationStatus.REQUESTED;
    const reason = `OPERATOR_${body.action}`;
    const transitioned = await this.operationRepository.transition(
      id,
      OperationStatus.REVIEW_REQUIRED,
      nextStatus,
      reason,
    );

    let lockReleased = false;
    if (body.action === 'RELEASE_LOCK') {
      await this.assetLockRepository.release(transitioned.tokenId);
      await this.dataSource
        .createQueryBuilder()
        .update(TransactionAttempt)
        .set({
          rawTransactionCiphertext: null,
          rawTransactionPurgedAt: () => 'CURRENT_TIMESTAMP(3)',
        })
        .where('operation_id = :id', { id })
        .andWhere('raw_transaction_ciphertext IS NOT NULL')
        .execute();
      lockReleased = true;
    }

    await this.auditWriter.writeAudit({
      category: AuditCategory.ADMIN_ACTION,
      actor: body.operator,
      action: reason,
      target: id,
      requestId: request.requestId,
      operationId: id,
      details: { note: body.note, previousReviewReason: operation.reviewReason, nextStatus },
    });
    await this.auditWriter.writeFailure({
      code: FailureCode.OPERATOR_RESOLVED,
      operationId: id,
      details: {
        action: body.action,
        operator: body.operator,
        note: body.note,
        previousReviewReason: operation.reviewReason,
      },
    });

    return {
      operationId: id,
      previousStatus: OperationStatus.REVIEW_REQUIRED,
      status: transitioned.status,
      lockReleased,
      action: body.action,
    };
  }
}
