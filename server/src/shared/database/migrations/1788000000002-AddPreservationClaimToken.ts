import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Preservation claim fencing (검증 피드백): `metadata_dependencies` gains `preservation_claim_token`.
 * `MetadataService` rewrites it on every `SUBMITTING` claim so a stale re-claim actually changes the
 * row (and refreshes `updated_at`), and so a late `preserve()` completion can only write its result
 * back while its own token still matches.
 */
export class AddPreservationClaimToken1788000000002 implements MigrationInterface {
  name = 'AddPreservationClaimToken1788000000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`metadata_dependencies\` ADD \`preservation_claim_token\` char(36) NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`metadata_dependencies\` DROP COLUMN \`preservation_claim_token\``);
  }
}
