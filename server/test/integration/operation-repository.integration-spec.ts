import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  IdempotencyConflictError,
  InvalidOperationTransitionError,
  OperationRepository,
} from '../../src/domains/operation/persistence/operation.repository';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { createTestDataSource } from './test-data-source';

function randomTokenId(): number {
  return Math.floor(Math.random() * 10_000) + 1;
}

describe('OperationRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: OperationRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    repository = new OperationRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('creates exactly one Operation when the same idempotencyKey is submitted concurrently', async () => {
    const idempotencyKey = randomUUID();
    const input = {
      idempotencyKey,
      type: OperationType.MINT,
      requestHash: 'a'.repeat(64),
      tokenId: randomTokenId(),
      toAddress: '0x1111111111111111111111111111111111111111',
    };

    const results = await Promise.all([
      repository.createOrGet(input),
      repository.createOrGet(input),
      repository.createOrGet(input),
      repository.createOrGet(input),
      repository.createOrGet(input),
    ]);

    const createdCount = results.filter((r) => r.created).length;
    expect(createdCount).toBe(1);

    const distinctOperationIds = new Set(results.map((r) => r.operation.id));
    expect(distinctOperationIds.size).toBe(1);

    const history = await repository.findHistory(results[0].operation.id);
    // Exactly one REQUESTED history row exists, not five — proves the losers of the race never
    // inserted their own Operation/history rows, they only read back the winner's.
    expect(history).toHaveLength(1);
    expect(history[0]!.toStatus).toBe(OperationStatus.REQUESTED);
  });

  it('rejects reuse of the same idempotencyKey with different request content', async () => {
    const idempotencyKey = randomUUID();
    const tokenId = randomTokenId();

    await repository.createOrGet({
      idempotencyKey,
      type: OperationType.MINT,
      requestHash: 'a'.repeat(64),
      tokenId,
    });

    await expect(
      repository.createOrGet({
        idempotencyKey,
        type: OperationType.MINT,
        requestHash: 'b'.repeat(64),
        tokenId,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('transitions status only when the expected status still matches, and records history', async () => {
    const { operation } = await repository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: 'c'.repeat(64),
      tokenId: randomTokenId(),
    });

    const updated = await repository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'submitted to chain',
    );
    expect(updated.status).toBe(OperationStatus.SUBMITTED);
    expect(updated.version).toBe(operation.version + 1);

    const history = await repository.findHistory(operation.id);
    expect(history).toHaveLength(2);
    expect(history[1]!.fromStatus).toBe(OperationStatus.REQUESTED);
    expect(history[1]!.toStatus).toBe(OperationStatus.SUBMITTED);
  });

  it('rejects a transition whose expectedStatus no longer matches the actual status', async () => {
    const { operation } = await repository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: 'd'.repeat(64),
      tokenId: randomTokenId(),
    });

    await expect(
      repository.transition(operation.id, OperationStatus.SUBMITTED, OperationStatus.PENDING, 'stale'),
    ).rejects.toBeInstanceOf(InvalidOperationTransitionError);

    // Status must be unchanged after the rejected transition.
    const stillRequested = await repository.findById(operation.id);
    expect(stillRequested?.status).toBe(OperationStatus.REQUESTED);
  });

  it('allows only one winner when two concurrent transitions race from the same expected status', async () => {
    const { operation } = await repository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: 'e'.repeat(64),
      tokenId: randomTokenId(),
    });

    const attempts = await Promise.allSettled([
      repository.transition(operation.id, OperationStatus.REQUESTED, OperationStatus.SUBMITTED, 'racer A'),
      repository.transition(operation.id, OperationStatus.REQUESTED, OperationStatus.CANCELLED, 'racer B'),
    ]);

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const final = await repository.findById(operation.id);
    expect([OperationStatus.SUBMITTED, OperationStatus.CANCELLED]).toContain(final?.status);

    const history = await repository.findHistory(operation.id);
    // REQUESTED (initial) + exactly one successful transition, never both.
    expect(history).toHaveLength(2);
  });
});
