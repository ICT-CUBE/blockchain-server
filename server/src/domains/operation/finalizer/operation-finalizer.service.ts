import { Injectable, Logger } from '@nestjs/common';
import { DataSource, type QueryDeepPartialEntity } from 'typeorm';

import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
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
 */
@Injectable()
export class OperationFinalizer {
  private readonly logger = new Logger(OperationFinalizer.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
  ) {}

  async apply(operation: Operation, result: ConfirmationResult): Promise<void> {
    switch (result.outcome) {
      case 'CONFIRMED': {
        await this.markWinner(
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
        await this.transition(operation, OperationStatus.ONCHAIN_CONFIRMED, 'CHAIN_CONFIRMED', metadataPatch);
        break;
      }
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

  private async transition(
    operation: Operation,
    nextStatus: OperationStatus,
    reason: string,
    metadataPatch?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.operationRepository.transition(operation.id, operation.status, nextStatus, reason);
    } catch {
      // Already moved by a concurrent pass — nothing left to do.
      return;
    }

    if (metadataPatch) {
      // See operation.repository.ts for why the json-column entity type forces this cast.
      const mergedMetadata = { ...(operation.metadata ?? {}), ...metadataPatch };
      await this.dataSource
        .createQueryBuilder()
        .update(Operation)
        .set({ metadata: mergedMetadata } as unknown as QueryDeepPartialEntity<Operation>)
        .where('id = :id', { id: operation.id })
        .execute();
    }

    if (LOCK_RELEASING_STATUSES.has(nextStatus)) {
      await this.assetLockRepository.release(operation.tokenId);
    }
  }

  private async markWinner(
    operationId: string,
    winningAttemptId: string,
    blockNumber: number,
    confirmations: number,
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({
        status: TransactionAttemptStatus.CONFIRMED,
        confirmationCount: confirmations,
        checkedAt: () => 'CURRENT_TIMESTAMP(3)',
      })
      .where('id = :id', { id: winningAttemptId })
      .execute();

    await this.dataSource
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
  }
}
