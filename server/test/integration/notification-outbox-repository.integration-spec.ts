import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '../../src/domains/notification/persistence/notification-delivery.entity';
import { NotificationOutboxRepository } from '../../src/domains/notification/persistence/notification-outbox.repository';
import { createTestDataSource } from './test-data-source';

// `claimDueBatch` orders by `nextAttemptAt ASC`, so a large limit is used throughout this suite:
// otherwise a claim in one test could be crowded out of a small LIMIT by older not-yet-terminal
// rows a previous run of this same suite left behind (this suite runs against a real, persistent
// test DB — see createTestDataSource — not a fresh one per run).
const GENEROUS_LIMIT = 1000;

describe('NotificationOutboxRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: NotificationOutboxRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    repository = new NotificationOutboxRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('a newly enqueued notification is immediately claimable', async () => {
    const notificationId = randomUUID();
    const enqueued = await repository.enqueue({
      notificationId,
      operationId: randomUUID(),
      payload: { ok: true },
    });

    const batch = await repository.claimDueBatch(GENEROUS_LIMIT);
    expect(batch.some((row) => row.notificationId === notificationId)).toBe(true);

    await repository.markDelivered(enqueued.id);
  });

  it('two concurrent claim calls never return overlapping rows', async () => {
    const enqueuedIds: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const enqueued = await repository.enqueue({
        notificationId: randomUUID(),
        operationId: randomUUID(),
        payload: {},
      });
      enqueuedIds.push(enqueued.id);
    }

    const [batchA, batchB] = await Promise.all([
      repository.claimDueBatch(GENEROUS_LIMIT),
      repository.claimDueBatch(GENEROUS_LIMIT),
    ]);

    const idsA = new Set(batchA.map((r) => r.id));
    const idsB = new Set(batchB.map((r) => r.id));
    const overlap = [...idsA].filter((id) => idsB.has(id));
    expect(overlap).toHaveLength(0);

    await Promise.all(enqueuedIds.map((id) => repository.markDelivered(id)));
  });

  it('a locked row is not reclaimed before its lock expires, but is after', async () => {
    const notificationId = randomUUID();
    const enqueued = await repository.enqueue({ notificationId, operationId: randomUUID(), payload: {} });

    const firstClaim = await repository.claimDueBatch(GENEROUS_LIMIT, 1);
    expect(firstClaim.some((r) => r.notificationId === notificationId)).toBe(true);

    const secondClaimImmediately = await repository.claimDueBatch(GENEROUS_LIMIT, 1);
    expect(secondClaimImmediately.some((r) => r.notificationId === notificationId)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const thirdClaimAfterExpiry = await repository.claimDueBatch(GENEROUS_LIMIT, 1);
    expect(thirdClaimAfterExpiry.some((r) => r.notificationId === notificationId)).toBe(true);

    await repository.markDelivered(enqueued.id);
  });

  it('markDelivered moves status to DELIVERED and clears the lock', async () => {
    const notificationId = randomUUID();
    const enqueued = await repository.enqueue({ notificationId, operationId: randomUUID(), payload: {} });
    await repository.claimDueBatch(GENEROUS_LIMIT);

    await repository.markDelivered(enqueued.id);

    const row = await dataSource.getRepository(NotificationDelivery).findOne({ where: { id: enqueued.id } });
    expect(row?.status).toBe(NotificationDeliveryStatus.DELIVERED);
    expect(row?.lockedUntil).toBeNull();
  });

  it('markAttemptFailed(RETRYING) increments attemptCount and reschedules nextAttemptAt', async () => {
    const notificationId = randomUUID();
    const enqueued = await repository.enqueue({ notificationId, operationId: randomUUID(), payload: {} });
    await repository.claimDueBatch(GENEROUS_LIMIT);

    const past = new Date();
    await repository.markAttemptFailed(
      enqueued.id,
      NotificationDeliveryStatus.RETRYING,
      past,
      'connect ECONNREFUSED',
    );

    const claimable = await repository.claimDueBatch(GENEROUS_LIMIT);
    const retried = claimable.find((r) => r.id === enqueued.id);
    expect(retried).toBeDefined();
    expect(retried?.status).toBe(NotificationDeliveryStatus.RETRYING);
    expect(retried?.attemptCount).toBe(1);
    expect(retried?.lastError).toContain('ECONNREFUSED');

    await repository.markDelivered(enqueued.id);
  });
});
