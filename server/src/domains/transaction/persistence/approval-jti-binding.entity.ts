import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Binds one ARZONE approval JWT (`jti`) to exactly one `(idempotencyKey, validCommandHash)` pair,
 * so an approval token can never be replayed against a different command than the one it was
 * issued for (TASK-06 §5: "jti+idempotencyKey+유효 명령 hash 원자 binding"). `jti` is unique — a JWT
 * is meant to be consumed exactly once; an exact resend of the same request is recognized by
 * comparing the stored `idempotencyKey`/`validCommandHash`, not by allowing a second row. */
@Entity('approval_jti_bindings')
export class ApprovalJtiBinding {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  jti!: string;

  @Column({ name: 'idempotency_key', type: 'char', length: 36 })
  idempotencyKey!: string;

  @Column({ name: 'valid_command_hash', type: 'char', length: 64 })
  validCommandHash!: string;

  @Column({ name: 'operation_id', type: 'char', length: 36 })
  operationId!: string;

  @CreateDateColumn({
    name: 'created_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  createdAt!: Date;
}
