import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';

export enum SignerNonceReservationStatus {
  /** Held by `attemptId` — either a signed attempt exists for it, or one is about to be signed. */
  ACTIVE = 'ACTIVE',
  /** Given back before any attempt was committed (fee/estimateGas/signing failed after
   * reservation). Re-used by the next `reserveNext` for the same signer so the gap closes. */
  RELEASED = 'RELEASED',
}

/** One row per (chainId, signerAddress, transactionNonce) ever reserved — the unique constraint is
 * what actually serializes nonce assignment for a signer across concurrent submissions (TASK-10).
 * Which numeric nonce to reserve next (max of RPC pending vs last DB nonce, or the lowest re-usable
 * released/orphaned one — 검증 D1) is `NonceCoordinator` business logic; this table only guarantees
 * that whichever value is chosen can be claimed by exactly one attempt at a time. */
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

  @Column({ type: 'enum', enum: SignerNonceReservationStatus, default: SignerNonceReservationStatus.ACTIVE })
  status!: SignerNonceReservationStatus;

  /** When the current `attemptId` took this nonce. An ACTIVE reservation with no
   * `transaction_attempts` row past the lease window is treated as orphaned (process died between
   * reserving and committing) and becomes re-usable. */
  @Column({ name: 'reserved_at', type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  reservedAt!: Date;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
