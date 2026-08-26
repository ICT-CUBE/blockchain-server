import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError, type QueryDeepPartialEntity } from 'typeorm';

import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { OperationStateHistory } from './operation-state-history.entity';
import { Operation } from './operation.entity';

export interface CreateOrGetOperationInput {
  idempotencyKey: string;
  type: OperationType;
  requestHash: string;
  tokenId: number;
  fromAddress?: string | null;
  toAddress?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreateOrGetOperationResult {
  operation: Operation;
  created: boolean;
}

/** Thrown by `createOrGet` when `idempotencyKey` was already used for a request whose normalized
 * content hashes differently — FR-032, "동일 키·다른 내용 충돌". */
export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Idempotency key ${idempotencyKey} was already used with different request content`);
    this.name = 'IdempotencyConflictError';
  }
}

/** Thrown by `transition` when the Operation's actual status no longer matches `expectedStatus` —
 * either it was already moved by a concurrent caller, or the caller's view is stale. */
export class InvalidOperationTransitionError extends Error {
  constructor(
    public readonly operationId: string,
    public readonly expectedStatus: OperationStatus,
    public readonly nextStatus: OperationStatus,
  ) {
    super(
      `Operation ${operationId} could not move ${expectedStatus} -> ${nextStatus}: ` +
        'actual status no longer matches expectedStatus',
    );
    this.name = 'InvalidOperationTransitionError';
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof error.driverError === 'object' &&
    error.driverError !== null &&
    'code' in error.driverError &&
    (error.driverError as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * The only repository in the operation domain with real persistence semantics beyond plain CRUD:
 * atomic idempotency resolution and compare-and-swap status transitions (TASK-04 §5/§7).
 */
@Injectable()
export class OperationRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Atomically creates a new Operation + its initial REQUESTED history row, or returns the
   * existing Operation for the same `idempotencyKey`. Concurrent callers racing on the same new
   * `idempotencyKey` are resolved deterministically: exactly one insert wins, the other(s) fall
   * back to reading the winner's row (FR-030/031). */
  async createOrGet(input: CreateOrGetOperationInput): Promise<CreateOrGetOperationResult> {
    // READ COMMITTED, not the MySQL default REPEATABLE READ: the first SELECT below establishes
    // a consistent snapshot for the whole transaction under REPEATABLE READ, so a loser of the
    // insert race would re-read that *same stale* snapshot after its duplicate-key error and never
    // see the winner's now-committed row. READ COMMITTED re-reads fresh on every statement instead.
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const existing = await manager.findOne(Operation, {
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { operation: existing, created: false };
      }

      const operation = manager.create(Operation, {
        id: randomUUID(),
        type: input.type,
        status: OperationStatus.REQUESTED,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        tokenId: input.tokenId,
        fromAddress: input.fromAddress ?? null,
        toAddress: input.toAddress ?? null,
        metadata: input.metadata ?? null,
      });

      try {
        // TypeORM's QueryDeepPartialEntity mapped type does not structurally accept a plain
        // `Record<string, unknown>` for a json column; this cast is the documented workaround, not
        // a loosening of this method's own type safety (`operation` is still a real `Operation`).
        await manager.insert(Operation, operation as unknown as QueryDeepPartialEntity<Operation>);
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
        // Lost the race on the idempotencyKey unique constraint: resolve exactly like the
        // "already exists" branch above, against whichever row actually won.
        const raced = await manager.findOneOrFail(Operation, {
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (raced.requestHash !== input.requestHash) {
          throw new IdempotencyConflictError(input.idempotencyKey);
        }
        return { operation: raced, created: false };
      }

      await manager.insert(OperationStateHistory, {
        id: randomUUID(),
        operationId: operation.id,
        fromStatus: null,
        toStatus: OperationStatus.REQUESTED,
        reason: 'created',
      });

      return { operation, created: true };
    });
  }

  /** Compare-and-swap status transition: succeeds only if the row's current status still equals
   * `expectedStatus` at the moment of the UPDATE, implemented as a single atomic
   * `UPDATE ... WHERE id = ? AND status = ?` (not a read-then-write race). Appends the matching
   * `OperationStateHistory` row in the same DB transaction. */
  async transition(
    operationId: string,
    expectedStatus: OperationStatus,
    nextStatus: OperationStatus,
    reason: string,
  ): Promise<Operation> {
    return this.dataSource.transaction(async (manager) => {
      const result = await manager
        .createQueryBuilder()
        .update(Operation)
        .set({ status: nextStatus, version: () => 'version + 1' })
        .where('id = :operationId', { operationId })
        .andWhere('status = :expectedStatus', { expectedStatus })
        .execute();

      if (result.affected !== 1) {
        throw new InvalidOperationTransitionError(operationId, expectedStatus, nextStatus);
      }

      await manager.insert(OperationStateHistory, {
        id: randomUUID(),
        operationId,
        fromStatus: expectedStatus,
        toStatus: nextStatus,
        reason,
      });

      return manager.findOneOrFail(Operation, { where: { id: operationId } });
    });
  }

  async findById(operationId: string): Promise<Operation | null> {
    return this.dataSource.getRepository(Operation).findOne({ where: { id: operationId } });
  }

  async findHistory(operationId: string): Promise<OperationStateHistory[]> {
    return this.dataSource
      .getRepository(OperationStateHistory)
      .find({ where: { operationId }, order: { occurredAt: 'ASC' } });
  }
}
