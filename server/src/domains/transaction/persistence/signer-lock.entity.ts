import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';

/** One row per (chainId, signerAddress) ever submitted from. `NonceCoordinator.reserveNext` takes
 * `SELECT ... FOR UPDATE` on it to serialize nonce assignment (TASK-10 §5). Since 검증 D1 it also
 * carries the per-signer circuit breaker: while `haltedReason` is set (a nonce gap was observed on
 * broadcast), new MAX+1 reservations are refused and only gap-filling re-use is allowed. */
@Entity('signer_locks')
@Unique(['chainId', 'signerAddress'])
export class SignerLock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'chain_id', type: 'int', unsigned: true })
  chainId!: number;

  @Column({ name: 'signer_address', type: 'varchar', length: 42, transformer: evmAddressTransformer })
  signerAddress!: string;

  /** e.g. `NONCE_GAP`. Null when the signer's pipeline is healthy. */
  @Column({ name: 'halted_reason', type: 'varchar', length: 64, nullable: true })
  haltedReason!: string | null;

  @Column({ name: 'halted_at', type: 'timestamp', precision: 3, nullable: true })
  haltedAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
