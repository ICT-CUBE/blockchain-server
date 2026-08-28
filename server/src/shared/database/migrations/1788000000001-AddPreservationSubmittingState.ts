import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preservation idempotency (검증 피드백): a repeated or concurrent `POST /internal/v1/metadata` for
 * the same content must not re-submit an already-`PRESERVED`/in-flight CID to Filebase. A new
 * transient `SUBMITTING` state on `metadata_dependencies.preservation_status` is the claim marker —
 * `MetadataService` transitions `PENDING`(no request id)/`FAILED` → `SUBMITTING` atomically and only
 * the winner calls `preserve()`.
 */
export class AddPreservationSubmittingState1788000000001 implements MigrationInterface {
  name = 'AddPreservationSubmittingState1788000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`metadata_dependencies\` MODIFY \`preservation_status\` ` +
        `enum ('PENDING', 'SUBMITTING', 'PRESERVED', 'FAILED') NOT NULL DEFAULT 'PENDING'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE \`metadata_dependencies\` SET \`preservation_status\` = 'PENDING' ` +
        `WHERE \`preservation_status\` = 'SUBMITTING'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`metadata_dependencies\` MODIFY \`preservation_status\` ` +
        `enum ('PENDING', 'PRESERVED', 'FAILED') NOT NULL DEFAULT 'PENDING'`,
    );
  }
}
