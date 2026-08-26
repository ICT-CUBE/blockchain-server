import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import {
  AssetLockConflictError,
  AssetLockRepository,
} from '../../src/domains/transaction/persistence/asset-lock.repository';
import { AssetLockStatus } from '../../src/domains/transaction/persistence/asset-lock.entity';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { createTestDataSource } from './test-data-source';

function randomTokenId(): number {
  return Math.floor(Math.random() * 10_000) + 1;
}

async function makeOperation(operationRepository: OperationRepository, tokenId: number): Promise<string> {
  const { operation } = await operationRepository.createOrGet({
    idempotencyKey: randomUUID(),
    type: OperationType.TRANSFER,
    requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
    tokenId,
  });
  return operation.id;
}

describe('AssetLockRepository (integration)', () => {
  let dataSource: DataSource;
  let assetLockRepository: AssetLockRepository;
  let operationRepository: OperationRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    assetLockRepository = new AssetLockRepository(dataSource);
    operationRepository = new OperationRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('allows only one of several concurrent lock attempts on the same tokenId to succeed', async () => {
    const tokenId = randomTokenId();
    const operationIds = await Promise.all(
      Array.from({ length: 5 }, () => makeOperation(operationRepository, tokenId)),
    );

    const attempts = await Promise.allSettled(
      operationIds.map((opId) => assetLockRepository.acquire(tokenId, opId)),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(AssetLockConflictError);
    }

    const active = await assetLockRepository.findActive(tokenId);
    expect(active).not.toBeNull();
    expect(active?.status).toBe(AssetLockStatus.ACTIVE);

    // Don't leak a permanently-active lock on this tokenId into later runs of this suite.
    await assetLockRepository.release(tokenId);
  });

  it('allows a new lock after the previous one is released', async () => {
    const tokenId = randomTokenId();
    const opA = await makeOperation(operationRepository, tokenId);
    await assetLockRepository.acquire(tokenId, opA);

    await expect(
      assetLockRepository.acquire(tokenId, await makeOperation(operationRepository, tokenId)),
    ).rejects.toBeInstanceOf(AssetLockConflictError);

    await assetLockRepository.release(tokenId);
    expect(await assetLockRepository.findActive(tokenId)).toBeNull();

    const opB = await makeOperation(operationRepository, tokenId);
    const lock = await assetLockRepository.acquire(tokenId, opB);
    expect(lock.operationId).toBe(opB);

    await assetLockRepository.release(tokenId);
  });

  it('release is idempotent for an already-released or never-locked tokenId', async () => {
    const tokenId = randomTokenId();
    await expect(assetLockRepository.release(tokenId)).resolves.toBeUndefined();

    const opA = await makeOperation(operationRepository, tokenId);
    await assetLockRepository.acquire(tokenId, opA);
    await assetLockRepository.release(tokenId);
    await expect(assetLockRepository.release(tokenId)).resolves.toBeUndefined();
  });
});
