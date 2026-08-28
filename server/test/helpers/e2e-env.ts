import path from 'node:path';

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'deployments');

export const HMAC_KEY_ID = 'backend-v1';
export const HMAC_SECRET = Buffer.alloc(32, 1);
export const HMAC_OPERATOR_KEY_ID = 'operator-v1';
export const HMAC_OPERATOR_SECRET = Buffer.alloc(32, 101);
export const APPROVAL_JWT_SECRET = Buffer.alloc(32, 2);
export const APPROVAL_JWT_ISSUER = 'arzone-backend';
export const APPROVAL_JWT_AUDIENCE = 'arzone-blockchain-server';

/** Sets every env var `AppModule` needs to boot for e2e tests. Requires a real, reachable
 * `DATABASE_URL` (default: the local MySQL `docker-compose.yml`'s `mysql` service documents) —
 * this suite boots the *whole* app, and `DatabaseModule` connects for real at `app.init()`. Point
 * `DATABASE_URL` at a disposable test database via the environment before running these specs. */
export function applyE2eTestEnv(): void {
  process.env.NODE_ENV = 'test';
  // Never actually bound: these suites call app.init(), not app.listen().
  process.env.PORT = '3100';
  process.env.CUBE_NFT_NETWORK = 'localhost';
  process.env.CUBE_NFT_DEPLOYMENTS_DIR = FIXTURES_DIR;
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft@127.0.0.1:3306/cube_nft';
  process.env.HMAC_INBOUND_KEY_ID = HMAC_KEY_ID;
  process.env.HMAC_INBOUND_KEY_SECRET = HMAC_SECRET.toString('base64url');
  process.env.HMAC_OPERATOR_KEY_ID = HMAC_OPERATOR_KEY_ID;
  process.env.HMAC_OPERATOR_KEY_SECRET = HMAC_OPERATOR_SECRET.toString('base64url');
  process.env.APPROVAL_JWT_SECRET = APPROVAL_JWT_SECRET.toString('base64url');
  process.env.APPROVAL_JWT_ISSUER = APPROVAL_JWT_ISSUER;
  process.env.APPROVAL_JWT_AUDIENCE = APPROVAL_JWT_AUDIENCE;
  // TASK-10/11: 'localhost' here is just this suite's fixture network name (see FIXTURES_DIR above),
  // not a real chain — not in env.schema.ts's LOCAL_NETWORK_NAMES, so these must be set explicitly.
  // No e2e spec actually submits a transaction, so the values only need to satisfy validation.
  process.env.RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.TRANSACTION_RPC_URL_PRIMARY = 'http://127.0.0.1:8545';
  process.env.MINT_SIGNER_PRIVATE_KEY = `0x${'4'.repeat(64)}`;
  process.env.RELAYER_SIGNER_PRIVATE_KEY = `0x${'5'.repeat(64)}`;
  // TASK-12: no e2e spec actually delivers a notification (that's the dedicated integration
  // suite's job, against a real HTTP receiver) — these only need to satisfy validation so
  // AppModule can boot.
  process.env.NOTIFICATION_CALLBACK_URL = 'http://127.0.0.1:4100/webhook';
  process.env.HMAC_OUTBOUND_KEY_ID = 'outbound-v1';
  process.env.HMAC_OUTBOUND_KEY_SECRET = Buffer.alloc(32, 10).toString('base64url');
}
