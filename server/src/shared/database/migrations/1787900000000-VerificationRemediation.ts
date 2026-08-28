import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema support for the 2026-08-28 verification remediation (docs/검증-종합-문제-원인-개선안.md):
 *
 * - D1  nonce lifecycle: reservations gain a `status` (ACTIVE/RELEASED) and `reserved_at` lease
 *       timestamp so a reservation whose attempt never got signed can be released and re-used to
 *       fill the gap; `signer_locks` gains a circuit-breaker (`halted_reason`/`halted_at`).
 * - D1  broadcast retry policy: attempts track `broadcast_attempt_count`, `next_broadcast_at`
 *       (exponential backoff) and a redacted `last_broadcast_error`.
 * - D6  ciphertext purge: `raw_transaction_ciphertext` becomes nullable so it can be purged.
 * - D3/D1 new failure codes for submission rejects, broadcast exhaustion, signer nonce gaps and
 *       operator resolutions.
 */
export class VerificationRemediation1787900000000 implements MigrationInterface {
  name = 'VerificationRemediation1787900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`signer_nonce_reservations\` ADD \`status\` enum ('ACTIVE', 'RELEASED') NOT NULL DEFAULT 'ACTIVE'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`signer_nonce_reservations\` ADD \`reserved_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)`,
    );
    await queryRunner.query(`ALTER TABLE \`signer_locks\` ADD \`halted_reason\` varchar(64) NULL`);
    await queryRunner.query(`ALTER TABLE \`signer_locks\` ADD \`halted_at\` timestamp(3) NULL`);
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` ADD \`broadcast_attempt_count\` int UNSIGNED NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` ADD \`next_broadcast_at\` timestamp(3) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` ADD \`last_broadcast_error\` varchar(255) NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` MODIFY \`raw_transaction_ciphertext\` text NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`failure_records\` MODIFY \`code\` enum ('LONG_PENDING', 'REPEATED_FAILURE', 'OWNER_MISMATCH', 'WEBHOOK_FAILED', 'SUBMISSION_REJECTED', 'BROADCAST_RETRY_EXHAUSTED', 'SIGNER_NONCE_GAP', 'OPERATOR_RESOLVED') NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`failure_records\` MODIFY \`code\` enum ('LONG_PENDING', 'REPEATED_FAILURE', 'OWNER_MISMATCH', 'WEBHOOK_FAILED') NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` MODIFY \`raw_transaction_ciphertext\` text NOT NULL`,
    );
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` DROP COLUMN \`last_broadcast_error\``);
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` DROP COLUMN \`next_broadcast_at\``);
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` DROP COLUMN \`broadcast_attempt_count\``);
    await queryRunner.query(`ALTER TABLE \`signer_locks\` DROP COLUMN \`halted_at\``);
    await queryRunner.query(`ALTER TABLE \`signer_locks\` DROP COLUMN \`halted_reason\``);
    await queryRunner.query(`ALTER TABLE \`signer_nonce_reservations\` DROP COLUMN \`reserved_at\``);
    await queryRunner.query(`ALTER TABLE \`signer_nonce_reservations\` DROP COLUMN \`status\``);
  }
}
