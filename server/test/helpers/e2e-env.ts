import path from 'node:path';

export const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'deployments');

export const HMAC_KEY_ID = 'backend-v1';
export const HMAC_SECRET = Buffer.alloc(32, 1);
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
  process.env.PORT = '3000';
  process.env.CUBE_NFT_NETWORK = 'localhost';
  process.env.CUBE_NFT_DEPLOYMENTS_DIR = FIXTURES_DIR;
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft@127.0.0.1:3306/cube_nft';
  process.env.HMAC_INBOUND_KEY_ID = HMAC_KEY_ID;
  process.env.HMAC_INBOUND_KEY_SECRET = HMAC_SECRET.toString('base64url');
  process.env.APPROVAL_JWT_SECRET = APPROVAL_JWT_SECRET.toString('base64url');
  process.env.APPROVAL_JWT_ISSUER = APPROVAL_JWT_ISSUER;
  process.env.APPROVAL_JWT_AUDIENCE = APPROVAL_JWT_AUDIENCE;
}
