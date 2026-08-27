import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

import { evmAddressTransformer } from '../../../shared/domain/evm-address.transformer';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { Operation } from '../../operation/persistence/operation.entity';

/** One submitted (or about-to-be-submitted) transaction for an Operation. An Operation can have
 * attempt 1..N: the original plus any fee-bump replacements (TASK-10). `txHash` is computed
 * locally right after signing, before broadcast, so it is known even if the process crashes
 * between signing and broadcast — recovery resubmits the same stored raw transaction rather than
 * re-signing (which would only be possible anyway if the raw tx were still available). */
@Entity('transaction_attempts')
@Unique(['operationId', 'attemptNo'])
@Unique(['chainId', 'txHash'])
@Index(['status'])
export class TransactionAttempt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @ManyToOne(() => Operation, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'operation_id' })
  operation!: Operation;

  @Column({ name: 'attempt_no', type: 'int', unsigned: true })
  attemptNo!: number;

  @Column({ name: 'chain_id', type: 'int', unsigned: true })
  chainId!: number;

  @Column({ name: 'signer_address', type: 'varchar', length: 42, transformer: evmAddressTransformer })
  signerAddress!: string;

  /** Stored as a string — MySQL BIGINT exceeds JS `number` precision for large nonces/blocks. */
  @Column({ name: 'transaction_nonce', type: 'bigint' })
  transactionNonce!: string;

  @Column({ name: 'tx_hash', type: 'char', length: 66 })
  txHash!: string;

  @Column({ type: 'enum', enum: TransactionAttemptStatus, default: TransactionAttemptStatus.SIGNED })
  status!: TransactionAttemptStatus;

  @Column({ name: 'max_fee_per_gas_wei', type: 'varchar', length: 78, nullable: true })
  maxFeePerGasWei!: string | null;

  @Column({ name: 'max_priority_fee_per_gas_wei', type: 'varchar', length: 78, nullable: true })
  maxPriorityFeePerGasWei!: string | null;

  /** AES-256-GCM (dev) / KMS envelope (prod) encrypted signed raw transaction. Purged once the
   * Operation reaches a terminal state and no further replacement is possible (TASK-10 §5). Never
   * returned by any API or written to logs. */
  @Column({ name: 'raw_transaction_ciphertext', type: 'text' })
  rawTransactionCiphertext!: string;

  @Column({ name: 'raw_transaction_purged_at', type: 'timestamp', precision: 3, nullable: true })
  rawTransactionPurgedAt!: Date | null;

  /** Self-reference: the earlier attempt (for the same operation/nonce) this one fee-bumps. */
  @Column({ name: 'replaces_attempt_id', type: 'char', length: 36, nullable: true })
  replacesAttemptId!: string | null;

  @Column({ name: 'receipt_block_number', type: 'bigint', nullable: true })
  receiptBlockNumber!: string | null;

  @Column({ name: 'receipt_block_hash', type: 'char', length: 66, nullable: true })
  receiptBlockHash!: string | null;

  /** Raw EVM receipt status: 1 = success, 0 = reverted. Null until a receipt is observed. */
  @Column({ name: 'receipt_status', type: 'tinyint', nullable: true })
  receiptStatus!: number | null;

  /** `latestBlockNumber - receiptBlockNumber + 1` as of the last confirmation evaluation
   * (TASK-11 §5). Recomputed on every `ConfirmationService.evaluate` pass, not just once. */
  @Column({ name: 'confirmation_count', type: 'int', unsigned: true, nullable: true })
  confirmationCount!: number | null;

  @Column({ name: 'checked_at', type: 'timestamp', precision: 3, nullable: true })
  checkedAt!: Date | null;

  @Column({ name: 'broadcast_at', type: 'timestamp', precision: 3, nullable: true })
  broadcastAt!: Date | null;

  @Column({ name: 'confirmed_at', type: 'timestamp', precision: 3, nullable: true })
  confirmedAt!: Date | null;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
