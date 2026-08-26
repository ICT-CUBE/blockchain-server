import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export enum AuditCategory {
  SECURITY = 'SECURITY',
  ADMIN_ACTION = 'ADMIN_ACTION',
  BUSINESS_EVENT = 'BUSINESS_EVENT',
}

/** Durable audit trail for admin/governance actions and other business-significant events that
 * must be attributable to an actor (TASK-14 §5). Written only via the small `AuditWriter` helper
 * (added alongside this table in TASK-04, extended per-domain in later tasks) — never directly by
 * ad hoc repository calls, so the allowlist/redaction discipline stays in one place. */
@Entity('audit_records')
@Index(['category'])
@Index(['operationId'])
export class AuditRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: AuditCategory })
  category!: AuditCategory;

  /** Who did it — a userId, service account name, or "SYSTEM". Never a secret/token. */
  @Column({ type: 'varchar', length: 128 })
  actor!: string;

  /** What they did — a stable short code, e.g. "GRANT_ROLE", "MINT_ACCEPTED". */
  @Column({ type: 'varchar', length: 128 })
  action!: string;

  /** What it was done to — e.g. a role name, tokenId, or operationId, as free text. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  target!: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId!: string | null;

  @Column({ name: 'operation_id', type: 'char', length: 36, nullable: true })
  operationId!: string | null;

  @Column({ type: 'json', nullable: true })
  details!: Record<string, unknown> | null;

  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  occurredAt!: Date;
}
