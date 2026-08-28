import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 검증 문제 2·3: metadata long-term preservation is asynchronous. `metadata_dependencies` gains
 * `preservation_request_id` (the archival provider's pin-request id) so a `PENDING` row can be
 * reconciled later — `preservation_status` only becomes `PRESERVED` once the provider reports the
 * pin is actually `pinned`, not merely `queued`.
 */
export class AddPreservationRequestId1788000000000 implements MigrationInterface {
  name = 'AddPreservationRequestId1788000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`metadata_dependencies\` ADD \`preservation_request_id\` varchar(255) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`metadata_dependencies\` DROP COLUMN \`preservation_request_id\``);
  }
}
