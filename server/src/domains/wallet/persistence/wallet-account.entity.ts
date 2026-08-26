import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';

export enum WalletAccountStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

/** One custodial wallet per Backend `userId` (TASK-05). Deliberately holds no secret material —
 * `providerRef` is an opaque Web3Auth-side reference, never a key or key share (NFR-006). */
@Entity('wallet_accounts')
export class WalletAccount {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id', type: 'varchar', length: 128, unique: true })
  userId!: string;

  @Column({ type: 'varchar', length: 42, unique: true, transformer: evmAddressTransformer })
  address!: string;

  @Column({ type: 'varchar', length: 64 })
  provider!: string;

  @Column({ name: 'provider_ref', type: 'varchar', length: 255 })
  providerRef!: string;

  @Column({ type: 'enum', enum: WalletAccountStatus, default: WalletAccountStatus.ACTIVE })
  status!: WalletAccountStatus;

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
