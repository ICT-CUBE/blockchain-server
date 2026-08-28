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

export type ServiceRightsState = 'EXTERNAL_INACTIVE' | 'ELIGIBLE_FOR_ACTIVATION';

/** 검증 D2/D7 (§4 계약): the outbound completion webhook body — the same shape
 * `openapi.yaml#/components/schemas/BlockchainEvent` documents. */
export interface BlockchainEventPayload extends Record<string, unknown> {
  notificationId: string;
  operationId: string;
  idempotencyKey: string;
  operationType: OperationType;
  tokenId: number;
  finalStatus: 'ONCHAIN_CONFIRMED';
  finalOwnerAddress: string;
  txHash: string;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  serviceRightsState: ServiceRightsState | null;
  confirmedAt: string;
}

/** 검증 D9/§4: the value `OperationType` → rights state mapping, shared with `OperationsController`. */
export function rightsStateFor(type: OperationType): ServiceRightsState | null {
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

/**
 * Turns a `ConfirmationService.evaluate` result into the actual state transition (TASK-11 §5's
 * "확정 결과 -> finalizer mapping"). Every transition is a compare-and-swap against the Operation's
 * status at the time it was read; losing that race (a concurrent finalizer pass, or the pending
 * monitor moving it to REVIEW_REQUIRED first) is treated as "someone else already handled this", not
 * an error.
 *
 * The CONFIRMED case additionally enqueues TASK-12's completion webhook — in the *same* DB
 * transaction as the ONCHAIN_CONFIRMED transition, the winning-attempt update (now including the
 * receipt evidence, 검증 D7), the asset lock release, and the raw-transaction ciphertext purge for
 * every attempt of the Operation (검증 D6 — after final confirmation no re-broadcast or RBF can ever
 * be needed), per TASK-12 §5 ("ONCHAIN_CONFIRMED와 업무 결과를 같은 DB transaction에서 outbox로 만든다").
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
        const txHash = await this.markWinner(manager, operation.id, result);

        const rightsState = rightsStateFor(operation.type);
        const metadataPatch: Record<string, unknown> = {
          actualOwner: result.actualOwner,
          confirmedBlockNumber: result.blockNumber,
          confirmedBlockHash: result.blockHash,
          confirmations: result.confirmations,
        };
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
        await this.purgeRawTransactions(manager, operation.id);

        const notificationId = randomUUID();
        const payload: BlockchainEventPayload = {
          notificationId,
          operationId: operation.id,
          idempotencyKey: operation.idempotencyKey,
          operationType: operation.type,
          tokenId: operation.tokenId,
          finalStatus: 'ONCHAIN_CONFIRMED',
          finalOwnerAddress: result.actualOwner,
          txHash,
          blockNumber: result.blockNumber,
          blockHash: result.blockHash,
          confirmations: result.confirmations,
          serviceRightsState: rightsState,
          confirmedAt: transitioned.updatedAt.toISOString(),
        };
        await this.notificationOutboxRepository.enqueue(
          { notificationId, operationId: operation.id, payload },
          manager,
        );
      });
    } catch {
      // Already moved by a concurrent pass — nothing left to do.
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
    if (nextStatus === OperationStatus.FAILED) {
      // ALL_ATTEMPTS_REVERTED is final on chain too — nothing left to re-broadcast (검증 D6).
      await this.purgeRawTransactions(this.dataSource.manager, operation.id);
    }
  }

  /** Records the winning attempt's receipt evidence (검증 D7) and supersedes every other attempt of
   * the Operation. Returns the winner's `txHash` for the notification payload. */
  private async markWinner(
    manager: EntityManager,
    operationId: string,
    result: Extract<ConfirmationResult, { outcome: 'CONFIRMED' }>,
  ): Promise<string> {
    const winner = await manager.findOneOrFail(TransactionAttempt, {
      where: { id: result.winningAttemptId },
    });

    await manager
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({
        status: TransactionAttemptStatus.CONFIRMED,
        confirmationCount: result.confirmations,
        receiptBlockNumber: String(result.blockNumber),
        receiptBlockHash: result.blockHash,
        receiptStatus: result.receiptStatus,
        checkedAt: () => 'CURRENT_TIMESTAMP(3)',
        confirmedAt: () => 'CURRENT_TIMESTAMP(3)',
      })
      .where('id = :id', { id: result.winningAttemptId })
      .execute();

    await manager
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({ status: TransactionAttemptStatus.SUPERSEDED })
      .where('operation_id = :operationId', { operationId })
      .andWhere('id != :winningAttemptId', { winningAttemptId: result.winningAttemptId })
      .andWhere('status != :confirmed', { confirmed: TransactionAttemptStatus.CONFIRMED })
      .execute();

    this.logger.log(
      `Operation ${operationId} confirmed at block ${result.blockNumber} (${result.confirmations} confirmations) via attempt ${result.winningAttemptId}`,
    );
    return winner.txHash;
  }

  /** 검증 D6: after final on-chain settlement the encrypted signed raw transactions of *every*
   * attempt are discarded — txHash, nonce, gas and result history stay (TASK-10 §5 불변식). */
  private async purgeRawTransactions(manager: EntityManager, operationId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({ rawTransactionCiphertext: null, rawTransactionPurgedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('operation_id = :operationId', { operationId })
      .andWhere('raw_transaction_ciphertext IS NOT NULL')
      .execute();
  }
}
