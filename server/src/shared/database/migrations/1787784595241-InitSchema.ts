import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1787784595241 implements MigrationInterface {
  name = 'InitSchema1787784595241';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`audit_records\` (\`id\` varchar(36) NOT NULL, \`category\` enum ('SECURITY', 'ADMIN_ACTION', 'BUSINESS_EVENT') NOT NULL, \`actor\` varchar(128) NOT NULL, \`action\` varchar(128) NOT NULL, \`target\` varchar(255) NULL, \`request_id\` varchar(64) NULL, \`operation_id\` char(36) NULL, \`details\` json NULL, \`occurred_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX \`IDX_6fc4dac73f71ab7913e904d18c\` (\`operation_id\`), INDEX \`IDX_b56f39135bacc812efac30a7f6\` (\`category\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`failure_records\` (\`id\` varchar(36) NOT NULL, \`code\` enum ('LONG_PENDING', 'REPEATED_FAILURE', 'OWNER_MISMATCH', 'WEBHOOK_FAILED') NOT NULL, \`operation_id\` char(36) NULL, \`attempt_id\` char(36) NULL, \`notification_id\` char(36) NULL, \`details\` json NULL, \`occurred_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`resolved_at\` timestamp(3) NULL, \`resolution\` varchar(255) NULL, INDEX \`IDX_1eaf84c8304fa07d397349dfa1\` (\`code\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`metadata_dependencies\` (\`id\` varchar(36) NOT NULL, \`token_id\` int UNSIGNED NOT NULL, \`cid\` varchar(255) NOT NULL, \`kind\` enum ('METADATA_JSON', 'IMAGE', 'OTHER') NOT NULL, \`pin_status\` enum ('PENDING', 'PINNED', 'FAILED') NOT NULL DEFAULT 'PENDING', \`preservation_status\` enum ('PENDING', 'PRESERVED', 'FAILED') NOT NULL DEFAULT 'PENDING', \`checksum\` char(64) NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_71fc08dbc7da39f9212328bb33\` (\`token_id\`, \`cid\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`outbox_notifications\` (\`id\` varchar(36) NOT NULL, \`notification_id\` char(36) NOT NULL, \`operation_id\` char(36) NOT NULL, \`status\` enum ('PENDING', 'RETRYING', 'DELIVERED', 'FAILED', 'REVIEW_REQUIRED') NOT NULL DEFAULT 'PENDING', \`payload\` json NOT NULL, \`attempt_count\` int UNSIGNED NOT NULL DEFAULT '0', \`last_attempt_at\` timestamp(3) NULL, \`next_attempt_at\` timestamp(3) NOT NULL, \`last_error\` varchar(255) NULL, \`locked_until\` timestamp(3) NULL, \`claim_token\` char(36) NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX \`IDX_ca1a0ad16901806738cdbf520d\` (\`status\`, \`next_attempt_at\`), UNIQUE INDEX \`IDX_a995f66a069299066dd77c08f6\` (\`notification_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`operations\` (\`id\` varchar(36) NOT NULL, \`type\` enum ('MINT', 'TRANSFER', 'WITHDRAWAL', 'REENTRY', 'EXTERNAL_RESALE') NOT NULL, \`status\` enum ('REQUESTED', 'SUBMITTED', 'PENDING', 'ONCHAIN_CONFIRMED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'REVIEW_REQUIRED', 'CANCELLED') NOT NULL DEFAULT 'REQUESTED', \`idempotency_key\` char(36) NOT NULL, \`request_hash\` char(64) NOT NULL, \`token_id\` int UNSIGNED NOT NULL, \`from_address\` varchar(42) NULL, \`to_address\` varchar(42) NULL, \`review_reason\` varchar(255) NULL, \`failure_code\` varchar(64) NULL, \`metadata\` json NULL, \`version\` int NOT NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), INDEX \`IDX_fee2f162a089c9c7dd63cced6e\` (\`token_id\`), INDEX \`IDX_73ad3956d75e2f7ea7a6c56fd8\` (\`status\`), UNIQUE INDEX \`IDX_0cecc3ed830623408ab7d90a85\` (\`idempotency_key\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`operation_state_history\` (\`id\` varchar(36) NOT NULL, \`operation_id\` varchar(36) NOT NULL, \`from_status\` enum ('REQUESTED', 'SUBMITTED', 'PENDING', 'ONCHAIN_CONFIRMED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'REVIEW_REQUIRED', 'CANCELLED') NULL, \`to_status\` enum ('REQUESTED', 'SUBMITTED', 'PENDING', 'ONCHAIN_CONFIRMED', 'COMPLETED', 'FAILED', 'UNKNOWN', 'REVIEW_REQUIRED', 'CANCELLED') NOT NULL, \`reason\` varchar(255) NULL, \`occurred_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX \`IDX_1420166e16fa37237ec2c2747a\` (\`operation_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`approval_jti_bindings\` (\`id\` varchar(36) NOT NULL, \`jti\` varchar(255) NOT NULL, \`idempotency_key\` char(36) NOT NULL, \`valid_command_hash\` char(64) NOT NULL, \`operation_id\` char(36) NOT NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_a2a90ff7d440fbe01871f43624\` (\`jti\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`asset_locks\` (\`id\` varchar(36) NOT NULL, \`token_id\` int UNSIGNED NOT NULL, \`active_token_id\` int UNSIGNED NULL, \`operation_id\` varchar(36) NOT NULL, \`status\` enum ('ACTIVE', 'RELEASED') NOT NULL DEFAULT 'ACTIVE', \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`released_at\` timestamp(3) NULL, INDEX \`IDX_b6ff6136f100314413d42fafa0\` (\`token_id\`), UNIQUE INDEX \`IDX_99ff3041469a136e437ff01f59\` (\`active_token_id\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`signer_nonce_reservations\` (\`id\` varchar(36) NOT NULL, \`chain_id\` int UNSIGNED NOT NULL, \`signer_address\` varchar(42) NOT NULL, \`transaction_nonce\` bigint NOT NULL, \`attempt_id\` char(36) NOT NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_7e0d2ebf9f39732a5b7da70d2a\` (\`chain_id\`, \`signer_address\`, \`transaction_nonce\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`transaction_attempts\` (\`id\` varchar(36) NOT NULL, \`operation_id\` varchar(36) NOT NULL, \`attempt_no\` int UNSIGNED NOT NULL, \`chain_id\` int UNSIGNED NOT NULL, \`signer_address\` varchar(42) NOT NULL, \`transaction_nonce\` bigint NOT NULL, \`tx_hash\` char(66) NOT NULL, \`status\` enum ('SIGNED', 'BROADCAST', 'CONFIRMED', 'FAILED', 'SUPERSEDED', 'REVIEW_REQUIRED') NOT NULL DEFAULT 'SIGNED', \`max_fee_per_gas_wei\` varchar(78) NULL, \`max_priority_fee_per_gas_wei\` varchar(78) NULL, \`raw_transaction_ciphertext\` text NOT NULL, \`raw_transaction_purged_at\` timestamp(3) NULL, \`replaces_attempt_id\` char(36) NULL, \`receipt_block_number\` bigint NULL, \`receipt_block_hash\` char(66) NULL, \`receipt_status\` tinyint NULL, \`broadcast_at\` timestamp(3) NULL, \`confirmed_at\` timestamp(3) NULL, \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), INDEX \`IDX_9d91a2cc266125fe9b45e7410f\` (\`status\`), UNIQUE INDEX \`IDX_d05eee2c7be2553c016244fecd\` (\`chain_id\`, \`tx_hash\`), UNIQUE INDEX \`IDX_291eef0f261ccfe537659dec0b\` (\`operation_id\`, \`attempt_no\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `CREATE TABLE \`wallet_accounts\` (\`id\` varchar(36) NOT NULL, \`user_id\` varchar(128) NOT NULL, \`address\` varchar(42) NOT NULL, \`provider\` varchar(64) NOT NULL, \`provider_ref\` varchar(255) NOT NULL, \`status\` enum ('ACTIVE', 'DISABLED') NOT NULL DEFAULT 'ACTIVE', \`created_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), \`updated_at\` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3), UNIQUE INDEX \`IDX_2fd289edcdb11bce54a50b191b\` (\`user_id\`), UNIQUE INDEX \`IDX_a7f7f55fed1f15f378735d7552\` (\`address\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
    await queryRunner.query(
      `ALTER TABLE \`operation_state_history\` ADD CONSTRAINT \`FK_1420166e16fa37237ec2c2747a0\` FOREIGN KEY (\`operation_id\`) REFERENCES \`operations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`asset_locks\` ADD CONSTRAINT \`FK_50671368d25a7afa8b8976abaf2\` FOREIGN KEY (\`operation_id\`) REFERENCES \`operations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` ADD CONSTRAINT \`FK_2a6b56663cbd1e919cf74badfae\` FOREIGN KEY (\`operation_id\`) REFERENCES \`operations\`(\`id\`) ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE \`transaction_attempts\` DROP FOREIGN KEY \`FK_2a6b56663cbd1e919cf74badfae\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`asset_locks\` DROP FOREIGN KEY \`FK_50671368d25a7afa8b8976abaf2\``,
    );
    await queryRunner.query(
      `ALTER TABLE \`operation_state_history\` DROP FOREIGN KEY \`FK_1420166e16fa37237ec2c2747a0\``,
    );
    await queryRunner.query(`DROP INDEX \`IDX_a7f7f55fed1f15f378735d7552\` ON \`wallet_accounts\``);
    await queryRunner.query(`DROP INDEX \`IDX_2fd289edcdb11bce54a50b191b\` ON \`wallet_accounts\``);
    await queryRunner.query(`DROP TABLE \`wallet_accounts\``);
    await queryRunner.query(`DROP INDEX \`IDX_291eef0f261ccfe537659dec0b\` ON \`transaction_attempts\``);
    await queryRunner.query(`DROP INDEX \`IDX_d05eee2c7be2553c016244fecd\` ON \`transaction_attempts\``);
    await queryRunner.query(`DROP INDEX \`IDX_9d91a2cc266125fe9b45e7410f\` ON \`transaction_attempts\``);
    await queryRunner.query(`DROP TABLE \`transaction_attempts\``);
    await queryRunner.query(`DROP INDEX \`IDX_7e0d2ebf9f39732a5b7da70d2a\` ON \`signer_nonce_reservations\``);
    await queryRunner.query(`DROP TABLE \`signer_nonce_reservations\``);
    await queryRunner.query(`DROP INDEX \`IDX_99ff3041469a136e437ff01f59\` ON \`asset_locks\``);
    await queryRunner.query(`DROP INDEX \`IDX_b6ff6136f100314413d42fafa0\` ON \`asset_locks\``);
    await queryRunner.query(`DROP TABLE \`asset_locks\``);
    await queryRunner.query(`DROP INDEX \`IDX_a2a90ff7d440fbe01871f43624\` ON \`approval_jti_bindings\``);
    await queryRunner.query(`DROP TABLE \`approval_jti_bindings\``);
    await queryRunner.query(`DROP INDEX \`IDX_1420166e16fa37237ec2c2747a\` ON \`operation_state_history\``);
    await queryRunner.query(`DROP TABLE \`operation_state_history\``);
    await queryRunner.query(`DROP INDEX \`IDX_0cecc3ed830623408ab7d90a85\` ON \`operations\``);
    await queryRunner.query(`DROP INDEX \`IDX_73ad3956d75e2f7ea7a6c56fd8\` ON \`operations\``);
    await queryRunner.query(`DROP INDEX \`IDX_fee2f162a089c9c7dd63cced6e\` ON \`operations\``);
    await queryRunner.query(`DROP TABLE \`operations\``);
    await queryRunner.query(`DROP INDEX \`IDX_a995f66a069299066dd77c08f6\` ON \`outbox_notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_ca1a0ad16901806738cdbf520d\` ON \`outbox_notifications\``);
    await queryRunner.query(`DROP TABLE \`outbox_notifications\``);
    await queryRunner.query(`DROP INDEX \`IDX_71fc08dbc7da39f9212328bb33\` ON \`metadata_dependencies\``);
    await queryRunner.query(`DROP TABLE \`metadata_dependencies\``);
    await queryRunner.query(`DROP INDEX \`IDX_1eaf84c8304fa07d397349dfa1\` ON \`failure_records\``);
    await queryRunner.query(`DROP TABLE \`failure_records\``);
    await queryRunner.query(`DROP INDEX \`IDX_b56f39135bacc812efac30a7f6\` ON \`audit_records\``);
    await queryRunner.query(`DROP INDEX \`IDX_6fc4dac73f71ab7913e904d18c\` ON \`audit_records\``);
    await queryRunner.query(`DROP TABLE \`audit_records\``);
  }
}
