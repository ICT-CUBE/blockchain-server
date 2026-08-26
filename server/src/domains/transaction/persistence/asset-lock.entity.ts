import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { Operation } from '../../operation/persistence/operation.entity';

export enum AssetLockStatus {
  ACTIVE = 'ACTIVE',
  RELEASED = 'RELEASED',
}

/** Prevents two conflicting Operations from racing on the same tokenId (FR-019/020). At most one
 * ACTIVE lock may exist per tokenId; enforced by the unique index on `activeTokenId`, which is
 * only non-null while `status = ACTIVE` — MySQL unique indexes treat multiple NULLs as distinct,
 * so any number of RELEASED rows for the same tokenId can coexist, but a second ACTIVE one cannot
 * be inserted. See "공통 Asset Lock 해제 Matrix" in the plan for which Operation statuses release
 * the lock. */
@Entity('asset_locks')
@Index(['activeTokenId'], { unique: true })
@Index(['tokenId'])
export class AssetLock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'token_id', type: 'int', unsigned: true })
  tokenId!: number;

  /** Mirrors `tokenId` while ACTIVE, set to NULL on release. See the unique-index note above. */
  @Column({ name: 'active_token_id', type: 'int', unsigned: true, nullable: true })
  activeTokenId!: number | null;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @ManyToOne(() => Operation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'operation_id' })
  operation!: Operation;

  @Column({ type: 'enum', enum: AssetLockStatus, default: AssetLockStatus.ACTIVE })
  status!: AssetLockStatus;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;

  @Column({ name: 'released_at', type: 'timestamp', precision: 3, nullable: true })
  releasedAt!: Date | null;
}
