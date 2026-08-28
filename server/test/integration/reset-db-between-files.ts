import mysql from 'mysql2/promise';

/**
 * `setupFilesAfterEnv` for the integration suite (검증 문제 2).
 *
 * Every integration spec shares one Hardhat node and one MySQL DB, and almost none of them clean up
 * after themselves — the suite has historically relied on a single TRUNCATE run by hand before the
 * whole `--runInBand` pass. That makes it order-dependent: a spec whose deliberate nonce-gap /
 * signer-halt test aborts before its own cleanup leaves a halt row (and dangling reservations)
 * that make every later spec touching the same fixed Hardhat dev signer fail with
 * `SignerHaltedError`, turning one real failure into a cascade of derived ones.
 *
 * Resetting the volatile (non-`migrations`) tables *before each spec file* gives every file the
 * same clean slate it gets when run on its own — which is the state in which the whole suite is
 * known green. History-preservation assertions all live inside a single file's lifetime (one
 * `beforeAll`), so a per-file reset never crosses them. The Hardhat chain itself still accumulates
 * blocks across a run; specs already tolerate that via `unmintedTokenId()` and on-chain nonce
 * re-sync once the reservation table is empty.
 */
const VOLATILE_TABLES = [
  'approval_jti_bindings',
  'asset_locks',
  'audit_records',
  'failure_records',
  'hmac_nonces',
  'metadata_dependencies',
  'operation_state_history',
  'operations',
  'outbox_notifications',
  'signer_locks',
  'signer_nonce_reservations',
  'transaction_attempts',
  'wallet_accounts',
];

beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) return; // the spec's own createTestDataSource() throws with a clear message

  const connection = await mysql.createConnection(url);
  try {
    await connection.query("SET SESSION time_zone = '+00:00'");
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of VOLATILE_TABLES) {
      await connection.query(`TRUNCATE TABLE \`${table}\``);
    }
    await connection.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await connection.end();
  }
});
