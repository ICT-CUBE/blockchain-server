import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { ApiError } from '../../../shared/http/api-error';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { NotificationDelivery } from '../../notification/persistence/notification-delivery.entity';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { TransactionAttempt } from '../../transaction/persistence/transaction-attempt.entity';
import type { OperationStateHistory } from '../persistence/operation-state-history.entity';
import type { Operation } from '../persistence/operation.entity';
import { InvalidOperationTransitionError, OperationRepository } from '../persistence/operation.repository';
import type { NotificationStateResponse, OperationResponse, TxAttemptResponse } from './operation.response';

/** `docs/openapi.yaml#/components/schemas/CancelRequest` — optional: a bare cancel is still valid,
 * a supplied reason is recorded in the state history for traceability. */
const cancelRequestSchema = z
  .object({
    reason: z.string().min(1).max(200).optional(),
  })
  .strict()
  .optional();
type CancelRequest = z.infer<typeof cancelRequestSchema>;

const RIGHTS_STATES = new Set(['EXTERNAL_INACTIVE', 'ELIGIBLE_FOR_ACTIVATION']);

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function toAttemptResponse(attempt: TransactionAttempt): TxAttemptResponse {
  return {
    attemptId: attempt.id,
    attemptNo: attempt.attemptNo,
    txHash: attempt.txHash,
    nonce: attempt.transactionNonce,
    status: attempt.status,
    receiptBlockNumber: attempt.receiptBlockNumber,
    receiptBlockHash: attempt.receiptBlockHash,
    receiptStatus: attempt.receiptStatus,
    confirmations: attempt.confirmationCount,
    broadcastAttemptCount: attempt.broadcastAttemptCount,
    lastBroadcastError: attempt.lastBroadcastError,
    broadcastAt: iso(attempt.broadcastAt),
    confirmedAt: iso(attempt.confirmedAt),
    createdAt: attempt.createdAt.toISOString(),
  };
}

function toNotificationResponse(delivery: NotificationDelivery | null): NotificationStateResponse | null {
  if (!delivery) {
    return null;
  }
  return {
    notificationId: delivery.notificationId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    lastAttemptAt: iso(delivery.lastAttemptAt),
    nextAttemptAt: iso(delivery.nextAttemptAt),
    lastError: delivery.lastError,
  };
}

function firstTransitionTo(history: OperationStateHistory[], status: OperationStatus): string | null {
  const row = history.find((entry) => entry.toStatus === status);
  return row ? row.occurredAt.toISOString() : null;
}

export function toOperationResponse(
  operation: Operation,
  attempts: TransactionAttempt[],
  notification: NotificationDelivery | null,
  history: OperationStateHistory[],
): OperationResponse {
  const ordered = [...attempts].sort((a, b) => a.attemptNo - b.attemptNo);
  const confirmed = ordered.find((attempt) => attempt.status === TransactionAttemptStatus.CONFIRMED);
  const latest = ordered.length > 0 ? ordered[ordered.length - 1] : undefined;
  const evidence = confirmed ?? latest;
  const metadata = operation.metadata ?? {};
  const rights = metadata.rightsState;
  const finalOwner = metadata.actualOwner;

  return {
    operationId: operation.id,
    idempotencyKey: operation.idempotencyKey,
    type: operation.type,
    status: operation.status,
    tokenId: operation.tokenId,
    fromAddress: operation.fromAddress,
    toAddress: operation.toAddress,
    reviewReason: operation.reviewReason,
    failureCode: operation.failureCode,
    currentTxHash: evidence?.txHash ?? null,
    confirmations: evidence?.confirmationCount ?? 0,
    finalOwnerAddress: typeof finalOwner === 'string' ? finalOwner : null,
    serviceRightsState:
      typeof rights === 'string' && RIGHTS_STATES.has(rights)
        ? (rights as OperationResponse['serviceRightsState'])
        : null,
    txAttempts: ordered.map(toAttemptResponse),
    notification: toNotificationResponse(notification),
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
    submittedAt: firstTransitionTo(history, OperationStatus.SUBMITTED),
    onchainConfirmedAt: firstTransitionTo(history, OperationStatus.ONCHAIN_CONFIRMED),
    completedAt: firstTransitionTo(history, OperationStatus.COMPLETED),
  };
}

/** `GET /internal/v1/operations/:id` (stateless read) and `POST /internal/v1/operations/:id/cancel`
 * (TASK-08 §5/§7: "제출 전 공식 거래 취소 endpoint는 REQUESTED 상태만 CANCELLED로 전이") — both HMAC
 * only, no approval JWT (TASK-06 §4). GET returns the confirmed/final result regardless of whether
 * the completion webhook has been delivered yet (TASK-12 §5: this must work "webhook 실패와 무관"),
 * together with every attempt's txHash/receipt evidence and the notification's own state (검증 D7,
 * AC-021/033). Cancel is intentionally generic across every Operation type, not Transfer-specific —
 * "not yet submitted, still cancellable" is the same condition everywhere a lock can be held. */
@Controller('internal/v1/operations')
@UseGuards(HmacGuard)
export class OperationsController {
  constructor(
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly dataSource: DataSource,
  ) {}

  @Get(':id')
  @HttpCode(200)
  async findById(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<OperationResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }
    return this.view(operation);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(new ZodValidationPipe(cancelRequestSchema)) body: CancelRequest,
  ): Promise<OperationResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }

    const reason = body?.reason ? `CANCELLED_BY_REQUEST: ${body.reason}` : 'CANCELLED_BY_REQUEST';
    try {
      const cancelled = await this.operationRepository.transition(
        id,
        OperationStatus.REQUESTED,
        OperationStatus.CANCELLED,
        reason,
      );
      await this.assetLockRepository.release(cancelled.tokenId);
      return this.view(cancelled);
    } catch (error) {
      if (error instanceof InvalidOperationTransitionError) {
        throw new ApiError(
          'OPERATION_NOT_CANCELLABLE',
          `Operation ${id} is not in REQUESTED status and can no longer be cancelled`,
          409,
        );
      }
      throw error;
    }
  }

  private async view(operation: Operation): Promise<OperationResponse> {
    const [attempts, notification, history] = await Promise.all([
      this.dataSource.getRepository(TransactionAttempt).find({ where: { operationId: operation.id } }),
      this.dataSource
        .getRepository(NotificationDelivery)
        .findOne({ where: { operationId: operation.id }, order: { createdAt: 'DESC' } }),
      this.operationRepository.findHistory(operation.id),
    ]);
    return toOperationResponse(operation, attempts, notification, history);
  }
}
