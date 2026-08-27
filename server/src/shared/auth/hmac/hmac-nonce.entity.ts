import { Column, Entity, PrimaryGeneratedColumn, Unique } from 'typeorm';

/** One row per `(keyId, nonce)` ever accepted. The unique constraint — not an application-level
 * read-then-write check — is what actually enforces one-time use under concurrent requests (HMAC
 * 규칙: "nonce 일회성", TASK-06 §5). */
@Entity('hmac_nonces')
@Unique(['keyId', 'nonce'])
export class HmacNonce {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'key_id', type: 'varchar', length: 128 })
  keyId!: string;

  @Column({ type: 'varchar', length: 255 })
  nonce!: string;

  @Column({
    name: 'consumed_at',
    type: 'timestamp',
    precision: 3,
    default: () => 'CURRENT_TIMESTAMP(3)',
  })
  consumedAt!: Date;
}
