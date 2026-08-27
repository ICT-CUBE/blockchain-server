import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type EntityManager, type QueryDeepPartialEntity } from 'typeorm';

import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { NotificationOutboxRepository } from '../../notification/persistence/notification-outbox.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { TransactionAttempt } from '../../transaction/persistence/transaction-attempt.entity';
import type { ConfirmationResult } from '../../transaction/confirmation/confirmation.service';
import { Operation } from '../persistence/operation.entity';
import { OperationRepository } from '../persistence/operation.repository';

/** Statuses the asset lock releases from — every terminal-or-under-review outcome except
 * REVIEW_REQUIRED itself, which deliberately keeps the token locked until a human resolves it
 * (TASK-11 §9: "자동 DB 소유권 복구도 하지 않는다"). */
const LOCK_RELEASING_STATUSES = new Set([
  OperationStatus.ONCHAIN_CONFIRMED,
  OperationStatus.FAILED,
  OperationStatus.CANCELLED,
]);

/**
 * Turns a `ConfirmationService.evaluate` result into the actual state transition (TASK-11 §5's
 * "확정 결과 -> finalizer mapping"). Every transition is a compare-and-swap against the Operation's
 * status at the time it was read; losing that race (a concurrent finalizer pass, or the pending
 * monitor moving it to REVIEW_REQUIRED first) is treated as "someone else already handled this", not
 * an error.
 *
 * The CONFIRMED case additionally enqueues TASK-12's completion webhook — in the *same* DB
 * transaction as the ONCHAIN_CONFIRMED transition, the winning-attempt update, and the asset lock
 * release, per TASK-12 §5 ("ONCHAIN_CONFIRMED와 업무 결과를 같은 DB transaction에서 outbox로 만든다"):
 * a crash right after commit still has a durable outbox row for `NotificationDeliveryWorker` to
 * find, even though nothing has been sent yet.
 */
@Injectable()
export class OperationFinalizer {
  private readonly logger = new Logger(OperationFinalizer.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly notificationOutboxRepository: NotificationOutboxRepository,
  ) {}

  async apply(operation: Operation, result: ConfirmationResult): Promise<void> {
    switch (result.outcome) {
      case 'CONFIRMED':
        await this.applyConfirmed(operation, result);
        break;
      case 'FAILED':
        await this.transition(operation, OperationStatus.FAILED, result.reason);
        break;
      case 'REVIEW_REQUIRED':
        await this.transition(operation, OperationStatus.REVIEW_REQUIRED, result.reason);
        break;
      case 'PENDING':
        // Nothing to do yet — the next reconciliation pass re-evaluates from scratch.
        break;
    }
  }

  private async applyConfirmed(
    operation: Operation,
    result: Extract<ConfirmationResult, { outcome: 'CONFIRMED' }>,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const txHash = await this.markWinner(
          manager,
          operation.id,
          result.winningAttemptId,
          result.blockNumber,
          result.confirmations,
        );

        const metadataPatch: Record<string, unknown> = { actualOwner: result.actualOwner };
        const rightsState = this.rightsStateFor(operation.type);
        if (rightsState) {
          metadataPatch.rightsState = rightsState;
        }

        const transitioned = await this.operationRepository.transition(
          operation.id,
          operation.status,
          OperationStatus.ONCHAIN_CONFIRMED,
          'CHAIN_CONFIRMED',
          manager,
        );

        const mergedMetadata = { ...(operation.metadata ?? {}), ...metadataPatch };
        await manager
          .createQueryBuilder()
          .update(Operation)
          .set({ metadata: mergedMetadata } as unknown as QueryDeepPartialEntity<Operation>)
          .where('id = :id', { id: operation.id })
          .execute();

        await this.assetLockRepository.release(operation.tokenId, manager);

        const notificationId = randomUUID();
        await this.notificationOutboxRepository.enqueue(
          {
            notificationId,
            operationId: operation.id,
            payload: {
              notificationId,
              operationId: operation.id,
              idempotencyKey: operation.idempotencyKey,
              type: operation.type,
              tokenId: operation.tokenId,
              finalOwner: result.actualOwner,
              txHash,
              confirmedAt: transitioned.updatedAt.toISOString(),
              rightsState: rightsState ?? null,
            },
          },
          manager,
        );
      });
    } catch {
      // Already moved by a concurrent pass — nothing left to do.
    }
  }

  /** TASK-09 §5: "결과는 EXTERNAL_INACTIVE 또는 ELIGIBLE_FOR_ACTIVATION을 반환하며 Backend 권리를 직접
   * 변경하지 않는다" — this only ever *reports* a derived state alongside the confirmed transfer;
   * actually activating/deactivating the associated CUBE service rights remains Backend's job. */
  private rightsStateFor(type: OperationType): 'EXTERNAL_INACTIVE' | 'ELIGIBLE_FOR_ACTIVATION' | null {
    switch (type) {
      case OperationType.WITHDRAWAL:
        return 'EXTERNAL_INACTIVE';
      case OperationType.REENTRY:
      case OperationType.EXTERNAL_RESALE:
        return 'ELIGIBLE_FOR_ACTIVATION';
      default:
        return null;
    }
  }

  private async transition(operation: Operation, nextStatus: OperationStatus, reason: string): Promise<void> {
    try {
      await this.operationRepository.transition(operation.id, operation.status, nextStatus, reason);
    } catch {
      // Already moved by a concurrent pass — nothing left to do.
      return;
    }

    if (LOCK_RELEASING_STATUSES.has(nextStatus)) {
      await this.assetLockRepository.release(operation.tokenId);
    }
  }

  /** Returns the winning attempt's `txHash` for the notification payload. */
  private async markWinner(
    manager: EntityManager,
    operationId: string,
    winningAttemptId: string,
    blockNumber: number,
    confirmations: number,
  ): Promise<string> {
    const winner = await manager.findOneOrFail(TransactionAttempt, { where: { id: winningAttemptId } });

    await manager
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({
        status: TransactionAttemptStatus.CONFIRMED,
        confirmationCount: confirmations,
        checkedAt: () => 'CURRENT_TIMESTAMP(3)',
      })
      .where('id = :id', { id: winningAttemptId })
      .execute();

    await manager
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({ status: TransactionAttemptStatus.SUPERSEDED })
      .where('operation_id = :operationId', { operationId })
      .andWhere('id != :winningAttemptId', { winningAttemptId })
      .andWhere('status != :confirmed', { confirmed: TransactionAttemptStatus.CONFIRMED })
      .execute();

    this.logger.log(
      `Operation ${operationId} confirmed at block ${blockNumber} via attempt ${winningAttemptId}`,
    );
    return winner.txHash;
  }
}
