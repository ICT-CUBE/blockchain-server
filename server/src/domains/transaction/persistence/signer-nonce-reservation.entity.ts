import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';

/** One row per (chainId, signerAddress, transactionNonce) ever reserved — the unique constraint is
 * what actually serializes nonce assignment for a signer across concurrent submissions (TASK-10).
 * Which numeric nonce to reserve next (max of RPC pending vs last DB nonce) is TASK-10 business
 * logic; this table only guarantees that whichever value is chosen can be claimed by exactly one
 * attempt. */
@Entity('signer_nonce_reservations')
@Unique(['chainId', 'signerAddress', 'transactionNonce'])
export class SignerNonceReservation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'chain_id', type: 'int', unsigned: true })
  chainId!: number;

  @Column({ name: 'signer_address', type: 'varchar', length: 42, transformer: evmAddressTransformer })
  signerAddress!: string;

  @Column({ name: 'transaction_nonce', type: 'bigint' })
  transactionNonce!: string;

  @Column({ name: 'attempt_id', type: 'char', length: 36 })
  attemptId!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
