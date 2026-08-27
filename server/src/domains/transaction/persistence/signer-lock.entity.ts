import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';

/** One row per (chainId, signerAddress) ever submitted from. Exists purely so
 * `NonceCoordinator.reserveNext` has something to `SELECT ... FOR UPDATE` — the row's own columns
 * carry no state, serialization is the point (TASK-10 §5 "signer별 row lock으로 nonce를 직렬 예약"). */
@Entity('signer_locks')
@Unique(['chainId', 'signerAddress'])
export class SignerLock {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'chain_id', type: 'int', unsigned: true })
  chainId!: number;

  @Column({ name: 'signer_address', type: 'varchar', length: 42, transformer: evmAddressTransformer })
  signerAddress!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
