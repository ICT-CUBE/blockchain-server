import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** Stable, allowlisted failure codes (TASK-14 §5). Extended, not replaced, as later tasks need
 * more — never repurpose a code's meaning once it ships. */
export enum FailureCode {
  LONG_PENDING = 'LONG_PENDING',
  REPEATED_FAILURE = 'REPEATED_FAILURE',
  OWNER_MISMATCH = 'OWNER_MISMATCH',
  WEBHOOK_FAILED = 'WEBHOOK_FAILED',
}

/** A durable record of a failure or inconsistency worth operator attention, distinct from
 * structured application logs (TASK-14 §4: "구조화 로그와 DB 감사는 목적을 분리"). `details` is
 * populated only through `AuditWriter`'s allowlist/redaction — never a raw payload dump. */
@Entity('failure_records')
@Index(['code'])
export class FailureRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: FailureCode })
  code!: FailureCode;

  @Column({ name: 'operation_id', type: 'char', length: 36, nullable: true })
  operationId!: string | null;

  @Column({ name: 'attempt_id', type: 'char', length: 36, nullable: true })
  attemptId!: string | null;

  @Column({ name: 'notification_id', type: 'char', length: 36, nullable: true })
  notificationId!: string | null;

  @Column({ type: 'json', nullable: true })
  details!: Record<string, unknown> | null;

  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  occurredAt!: Date;

  @Column({ name: 'resolved_at', type: 'timestamp', precision: 3, nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  resolution!: string | null;
}
