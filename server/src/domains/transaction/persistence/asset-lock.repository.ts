import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, QueryFailedError, type QueryDeepPartialEntity } from 'typeorm';

import { AssetLock, AssetLockStatus } from './asset-lock.entity';

/** Thrown by `acquire` when `tokenId` already has an ACTIVE lock held by a different Operation
 * (FR-019/020: "NFT당 단일 활성 이전", "충돌 작업 잠금"). */
export class AssetLockConflictError extends Error {
  constructor(public readonly tokenId: number) {
    super(`tokenId ${tokenId} already has an active asset lock`);
    this.name = 'AssetLockConflictError';
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

/** Custom repository for the one piece of real persistence semantics in the asset-lock table:
 * "at most one ACTIVE lock per tokenId", enforced atomically via a unique-index insert rather than
 * a read-then-write check (TASK-04 §5/§7). */
@Injectable()
export class AssetLockRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Atomically acquires the lock for `tokenId` on behalf of `operationId`, or throws
   * `AssetLockConflictError` if another Operation currently holds it. Pass `manager` to acquire
   * atomically alongside the Operation row it belongs to (see `OperationIntakeService`) — otherwise
   * this runs as its own standalone insert. */
  async acquire(tokenId: number, operationId: string, manager?: EntityManager): Promise<AssetLock> {
    const repository = (manager ?? this.dataSource).getRepository(AssetLock);
    const lock = repository.create({
      id: randomUUID(),
      tokenId,
      activeTokenId: tokenId,
      operationId,
      status: AssetLockStatus.ACTIVE,
      releasedAt: null,
    });

    try {
      // See operation.repository.ts for why the (transitively json-column-carrying) relation type
      // forces this cast.
      await repository.insert(lock as unknown as QueryDeepPartialEntity<AssetLock>);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new AssetLockConflictError(tokenId);
      }
      throw error;
    }

    return lock;
  }

  /** Releases whichever lock is currently ACTIVE for `tokenId`, if any. Idempotent: releasing an
   * already-released (or never-locked) tokenId is a no-op, since multiple call sites in the Asset
   * Lock 해제 Matrix may reach this defensively. */
  async release(tokenId: number): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(AssetLock)
      .set({
        status: AssetLockStatus.RELEASED,
        activeTokenId: null,
        releasedAt: () => 'CURRENT_TIMESTAMP(3)',
      })
      .where('token_id = :tokenId', { tokenId })
      .andWhere('status = :status', { status: AssetLockStatus.ACTIVE })
      .execute();
  }

  async findActive(tokenId: number): Promise<AssetLock | null> {
    return this.dataSource.getRepository(AssetLock).findOne({
      where: { tokenId, status: AssetLockStatus.ACTIVE },
    });
  }
}
