import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

export enum NotificationDeliveryStatus {
  PENDING = 'PENDING',
  RETRYING = 'RETRYING',
  DELIVERED = 'DELIVERED',
  FAILED = 'FAILED',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
}

/** Outbox row for one Backend-bound completion webhook (TASK-12). Written in the same DB
 * transaction as the Operation reaching `ONCHAIN_CONFIRMED` so delivery is guaranteed to be
 * attempted at least once even if the process crashes immediately after — this is what makes it an
 * "outbox" rather than a plain queue entry (TASK-04 §4 구현 설계). */
@Entity('outbox_notifications')
@Index(['status', 'nextAttemptAt'])
export class NotificationDelivery {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** External-facing id included in the webhook payload for the receiver's own dedup. */
  @Column({ name: 'notification_id', type: 'char', length: 36, unique: true })
  notificationId!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @Column({ type: 'enum', enum: NotificationDeliveryStatus, default: NotificationDeliveryStatus.PENDING })
  status!: NotificationDeliveryStatus;

  @Column({ type: 'json' })
  payload!: Record<string, unknown>;

  @Column({ name: 'attempt_count', type: 'int', unsigned: true, default: 0 })
  attemptCount!: number;

  @Column({ name: 'last_attempt_at', type: 'timestamp', precision: 3, nullable: true })
  lastAttemptAt!: Date | null;

  @Column({ name: 'next_attempt_at', type: 'timestamp', precision: 3 })
  nextAttemptAt!: Date;

  @Column({ name: 'last_error', type: 'varchar', length: 255, nullable: true })
  lastError!: string | null;

  /** Set together with `claimToken` by `NotificationOutboxRepository.claimDueBatch` so a worker
   * process crashing mid-delivery doesn't permanently strand the row; a stale lock (past
   * `lockedUntil`) becomes claimable again. */
  @Column({ name: 'locked_until', type: 'timestamp', precision: 3, nullable: true })
  lockedUntil!: Date | null;

  @Column({ name: 'claim_token', type: 'char', length: 36, nullable: true })
  claimToken!: string | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @UpdateDateColumn({
    name: 'updated_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
    onUpdate: 'CURRENT_TIMESTAMP(3)',
  })
  updatedAt!: Date;
}
