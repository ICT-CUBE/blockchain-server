import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { Operation } from './operation.entity';

/** Append-only record of every status transition an Operation goes through. Never updated or
 * deleted — this is the audit trail `GET /operations/:id` and reconciliation read from. */
@Entity('operation_state_history')
@Index(['operationId'])
export class OperationStateHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @ManyToOne(() => Operation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'operation_id' })
  operation!: Operation;

  /** Null for the initial REQUESTED row created alongside the Operation itself. */
  @Column({ name: 'from_status', type: 'enum', enum: OperationStatus, nullable: true })
  fromStatus!: OperationStatus | null;

  @Column({ name: 'to_status', type: 'enum', enum: OperationStatus })
  toStatus!: OperationStatus;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason!: string | null;

  @CreateDateColumn({
    name: 'occurred_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  occurredAt!: Date;
}
