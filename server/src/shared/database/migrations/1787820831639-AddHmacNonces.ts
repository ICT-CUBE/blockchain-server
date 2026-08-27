import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddHmacNonces1787820831639 implements MigrationInterface {
  name = 'AddHmacNonces1787820831639';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`hmac_nonces\` (\`id\` varchar(36) NOT NULL, \`key_id\` varchar(128) NOT NULL, \`nonce\` varchar(255) NOT NULL, \`consumed_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_58bd2acedf8f17e6110e891740\` (\`key_id\`, \`nonce\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX \`IDX_58bd2acedf8f17e6110e891740\` ON \`hmac_nonces\``);
    await queryRunner.query(`DROP TABLE \`hmac_nonces\``);
  }
}
