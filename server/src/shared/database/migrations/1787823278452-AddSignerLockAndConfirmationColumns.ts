import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSignerLockAndConfirmationColumns1787823278452 implements MigrationInterface {
  name = 'AddSignerLockAndConfirmationColumns1787823278452';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`signer_locks\` (\`id\` varchar(36) NOT NULL, \`chain_id\` int UNSIGNED NOT NULL, \`signer_address\` varchar(42) NOT NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_dea30900db671055fb463a2d4c\` (\`chain_id\`, \`signer_address\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` ADD \`confirmation_count\` int UNSIGNED NULL`,
    );
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` ADD \`checked_at\` timestamp(3) NULL`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` DROP COLUMN \`checked_at\``);
    await queryRunner.query(`ALTER TABLE \`transaction_attempts\` DROP COLUMN \`confirmation_count\``);
    await queryRunner.query(`DROP INDEX \`IDX_dea30900db671055fb463a2d4c\` ON \`signer_locks\``);
    await queryRunner.query(`DROP TABLE \`signer_locks\``);
  }
}
