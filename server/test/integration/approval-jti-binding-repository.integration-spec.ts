import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  ApprovalJtiBindingRepository,
  ApprovalJtiReplayError,
} from '../../src/domains/transaction/persistence/approval-jti-binding.repository';
import { createTestDataSource } from './test-data-source';

describe('ApprovalJtiBindingRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: ApprovalJtiBindingRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    repository = new ApprovalJtiBindingRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('binds a new jti and returns created: true', async () => {
    const result = await repository.bindOrConflict({
      jti: randomUUID(),
      idempotencyKey: randomUUID(),
      validCommandHash: 'a'.repeat(64),
      operationId: randomUUID(),
    });
    expect(result.created).toBe(true);
  });

  it('an exact resend (same jti + same idempotencyKey + same hash) returns the original binding', async () => {
    const jti = randomUUID();
    const idempotencyKey = randomUUID();
    const validCommandHash = 'b'.repeat(64);
    const operationId = randomUUID();

    const first = await repository.bindOrConflict({ jti, idempotencyKey, validCommandHash, operationId });
    const second = await repository.bindOrConflict({ jti, idempotencyKey, validCommandHash, operationId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.binding.id).toBe(first.binding.id);
  });

  it('reusing a jti with a different idempotencyKey/hash is rejected as replay', async () => {
    const jti = randomUUID();
    await repository.bindOrConflict({
      jti,
      idempotencyKey: randomUUID(),
      validCommandHash: 'c'.repeat(64),
      operationId: randomUUID(),
    });

    await expect(
      repository.bindOrConflict({
        jti,
        idempotencyKey: randomUUID(),
        validCommandHash: 'd'.repeat(64),
        operationId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(ApprovalJtiReplayError);
  });

  it('resolves a race between concurrent binds of the same jti to exactly one created: true', async () => {
    const jti = randomUUID();
    const idempotencyKey = randomUUID();
    const validCommandHash = 'e'.repeat(64);
    const operationId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repository.bindOrConflict({ jti, idempotencyKey, validCommandHash, operationId }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.binding.id)).size).toBe(1);
  });
});
