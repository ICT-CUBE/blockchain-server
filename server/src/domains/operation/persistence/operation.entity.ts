import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';

/** A single logical unit of work (Mint/Transfer/Withdrawal/Reentry/External Resale). One Operation
 * can have many `TransactionAttempt`s but represents exactly one business request — this is the row
 * `idempotencyKey` resolves to (FR-030~032). See TASK-04 §4/§5. */
@Entity('operations')
@Index(['status'])
@Index(['tokenId'])
export class Operation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: OperationType })
  type!: OperationType;

  @Column({ type: 'enum', enum: OperationStatus, default: OperationStatus.REQUESTED })
  status!: OperationStatus;

  @Column({ name: 'idempotency_key', type: 'char', length: 36, unique: true })
  idempotencyKey!: string;

  /** Hash of the normalized, business-meaningful fields of the request (operation type, tokenId,
   * addresses, purpose, …). Used by `OperationRepository.createOrGet` to tell an exact resend
   * (same hash → return existing Operation) apart from a conflicting reuse of the same
   * idempotencyKey with different content (different hash → reject, FR-032). */
  @Column({ name: 'request_hash', type: 'char', length: 64 })
  requestHash!: string;

  @Column({ name: 'token_id', type: 'int', unsigned: true })
  tokenId!: number;

  @Column({
    name: 'from_address',
    type: 'varchar',
    length: 42,
    nullable: true,
    transformer: evmAddressTransformer,
  })
  fromAddress!: string | null;

  @Column({
    name: 'to_address',
    type: 'varchar',
    length: 42,
    nullable: true,
    transformer: evmAddressTransformer,
  })
  toAddress!: string | null;

  /** Stable machine-readable reason the Operation is sitting in REVIEW_REQUIRED, if it is. */
  @Column({ name: 'review_reason', type: 'varchar', length: 255, nullable: true })
  reviewReason!: string | null;

  /** Stable machine-readable failure code, if `status` is FAILED. */
  @Column({ name: 'failure_code', type: 'varchar', length: 64, nullable: true })
  failureCode!: string | null;

  /** Domain-specific fields that don't warrant their own column yet (e.g. cubeId, userId, trade
   * claim data used by later tasks). Never holds secrets — same allowlist discipline as
   * `AuditWriter` (TASK-14). */
  @Column({ type: 'json', nullable: true })
  metadata!: Record<string, unknown> | null;

  @VersionColumn()
  version!: number;

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
