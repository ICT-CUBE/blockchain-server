import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, type QueryDeepPartialEntity } from 'typeorm';

import { NotificationDelivery, NotificationDeliveryStatus } from './notification-delivery.entity';

export interface EnqueueNotificationInput {
  notificationId: string;
  operationId: string;
  payload: Record<string, unknown>;
}

const DEFAULT_CLAIM_LOCK_SECONDS = 30;

/**
 * The one piece of real persistence semantics in the notification domain: atomically claiming a
 * batch of due, unlocked outbox rows so multiple delivery workers never send the same webhook
 * twice concurrently (TASK-04 §5/§7; delivery/backoff business logic itself is TASK-12).
 */
@Injectable()
export class NotificationOutboxRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Pass `manager` to enqueue atomically alongside the Operation reaching ONCHAIN_CONFIRMED (see
   * `OperationRepository.transition`'s identical note) — this is what makes it an outbox rather
   * than a plain queue insert. */
  async enqueue(input: EnqueueNotificationInput, manager?: EntityManager): Promise<NotificationDelivery> {
    const repository = (manager ?? this.dataSource).getRepository(NotificationDelivery);
    const delivery = repository.create({
      id: randomUUID(),
      notificationId: input.notificationId,
      operationId: input.operationId,
      status: NotificationDeliveryStatus.PENDING,
      payload: input.payload,
      attemptCount: 0,
      lastAttemptAt: null,
      nextAttemptAt: new Date(),
      lastError: null,
      lockedUntil: null,
      claimToken: null,
    });
    // See operation.repository.ts for why the JSON column forces this cast.
    await repository.insert(delivery as unknown as QueryDeepPartialEntity<NotificationDelivery>);
    return delivery;
  }

  /** Atomically claims up to `limit` due (PENDING/RETRYING, `nextAttemptAt` in the past, not
   * currently locked by another claimer) rows for `lockSeconds`, and returns exactly those rows.
   * Implemented as a single `UPDATE ... ORDER BY ... LIMIT` tagging the claimed rows with a fresh
   * `claimToken`, followed by a `SELECT` on that token — MySQL does not support `SELECT ... FOR
   * UPDATE SKIP LOCKED` combined with `ORDER BY/LIMIT` claim-and-return in one round trip, so this
   * two-step form is the atomic primitive instead. A worker that dies mid-delivery simply leaves
   * the row locked until `lockedUntil` passes, after which it becomes claimable again. */
  async claimDueBatch(
    limit: number,
    lockSeconds = DEFAULT_CLAIM_LOCK_SECONDS,
  ): Promise<NotificationDelivery[]> {
    const claimToken = randomUUID();

    // Every time comparison here uses the DB's own clock (`NOW(3)`), never the application's
    // `new Date()`: with several worker processes (or a DB on another host/VM) the two clocks drift
    // by tens of milliseconds, which is enough for "expired according to one clock, not yet to the
    // other" and hence a row that is claimable or not depending on who asks (검증 개선안 §7).
    await this.dataSource.query(
      `UPDATE outbox_notifications
       SET claim_token = ?, locked_until = DATE_ADD(NOW(3), INTERVAL ? SECOND)
       WHERE status IN (?, ?)
         AND next_attempt_at <= NOW(3)
         AND (locked_until IS NULL OR locked_until < NOW(3))
       ORDER BY next_attempt_at ASC
       LIMIT ?`,
      [
        claimToken,
        lockSeconds,
        NotificationDeliveryStatus.PENDING,
        NotificationDeliveryStatus.RETRYING,
        limit,
      ],
    );

    return this.dataSource.getRepository(NotificationDelivery).find({ where: { claimToken } });
  }

  async markDelivered(id: string): Promise<void> {
    await this.dataSource.getRepository(NotificationDelivery).update(
      { id },
      {
        status: NotificationDeliveryStatus.DELIVERED,
        lastAttemptAt: new Date(),
        lastError: null,
        lockedUntil: null,
        claimToken: null,
      },
    );
  }

  async findByNotificationId(notificationId: string): Promise<NotificationDelivery | null> {
    return this.dataSource.getRepository(NotificationDelivery).findOne({ where: { notificationId } });
  }

  /** TASK-12 §5's manual redelivery path: resets a REVIEW_REQUIRED/FAILED row back to PENDING with
   * `nextAttemptAt` now and `attemptCount` untouched (the history of prior attempts is preserved,
   * not reset), so the next delivery-worker tick picks it up immediately under the *same*
   * `notificationId` (the receiver's own dedup key is unchanged — this is a redelivery, not a new
   * notification). */
  async resetForRedelivery(notificationId: string): Promise<NotificationDelivery> {
    await this.dataSource
      .createQueryBuilder()
      .update(NotificationDelivery)
      .set({
        status: NotificationDeliveryStatus.PENDING,
        nextAttemptAt: new Date(),
        lockedUntil: null,
        claimToken: null,
      })
      .where('notification_id = :notificationId', { notificationId })
      .execute();
    const updated = await this.findByNotificationId(notificationId);
    if (!updated) {
      throw new Error(`No notification found with notificationId ${notificationId}`);
    }
    return updated;
  }

  async markAttemptFailed(
    id: string,
    nextStatus:
      | NotificationDeliveryStatus.RETRYING
      | NotificationDeliveryStatus.FAILED
      | NotificationDeliveryStatus.REVIEW_REQUIRED,
    nextAttemptAt: Date,
    error: string,
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(NotificationDelivery)
      .set({
        status: nextStatus,
        attemptCount: () => 'attempt_count + 1',
        lastAttemptAt: new Date(),
        nextAttemptAt,
        lastError: error.slice(0, 255),
        lockedUntil: null,
        claimToken: null,
      })
      .where('id = :id', { id })
      .execute();
  }
}
