import path from 'node:path';

import { loadConfig } from './app-config';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'deployments');

/** A valid base64url secret (>=32 raw bytes) for tests only — never a real key. */
const TEST_SECRET_A = Buffer.alloc(32, 1).toString('base64url');
const TEST_SECRET_B = Buffer.alloc(32, 2).toString('base64url');

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    CUBE_NFT_NETWORK: 'localhost',
    CUBE_NFT_DEPLOYMENTS_DIR: FIXTURES_DIR,
    DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/cube_nft_test',
    HMAC_INBOUND_KEY_ID: 'backend-v1',
    HMAC_INBOUND_KEY_SECRET: TEST_SECRET_A,
    APPROVAL_JWT_SECRET: TEST_SECRET_B,
    APPROVAL_JWT_ISSUER: 'arzone-backend',
    APPROVAL_JWT_AUDIENCE: 'arzone-blockchain-server',
    ...overrides,
  };
}

describe('loadConfig', () => {
  it('loads valid env and the matching deployment fixture', () => {
    const config = loadConfig(baseEnv());

    expect(config.nodeEnv).toBe('test');
    expect(config.port).toBe(3000);
    expect(config.cubeNft.deployment.chainId).toBe(31337);
    expect(config.cubeNft.deployment.proxyAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(config.cubeNft.abi.length).toBeGreaterThan(0);
    expect(config.database.url).toBe('mysql://user:pass@127.0.0.1:3306/cube_nft_test');
    expect(config.database.poolMax).toBe(10);
    expect(config.hmacInbound.current.keyId).toBe('backend-v1');
    expect(config.hmacInbound.current.secret).toEqual(Buffer.from(TEST_SECRET_A, 'base64url'));
    expect(config.hmacInbound.previous).toBeNull();
    expect(config.approvalJwt.issuer).toBe('arzone-backend');
    expect(config.approvalJwt.audience).toBe('arzone-blockchain-server');
  });

  it('loads a previous HMAC key when both its id and secret are set (rotation window)', () => {
    const config = loadConfig(
      baseEnv({
        HMAC_INBOUND_PREVIOUS_KEY_ID: 'backend-v0',
        HMAC_INBOUND_PREVIOUS_KEY_SECRET: TEST_SECRET_B,
      }),
    );

    expect(config.hmacInbound.previous).toEqual({
      keyId: 'backend-v0',
      secret: Buffer.from(TEST_SECRET_B, 'base64url'),
    });
  });

  it('fails fast when only one half of the previous HMAC key pair is set', () => {
    expect(() => loadConfig(baseEnv({ HMAC_INBOUND_PREVIOUS_KEY_ID: 'backend-v0' }))).toThrow();
    expect(() => loadConfig(baseEnv({ HMAC_INBOUND_PREVIOUS_KEY_SECRET: TEST_SECRET_B }))).toThrow();
  });

  it('fails fast when a secret decodes to fewer than 32 bytes', () => {
    const shortSecret = Buffer.alloc(16, 9).toString('base64url');
    expect(() => loadConfig(baseEnv({ HMAC_INBOUND_KEY_SECRET: shortSecret }))).toThrow();
    expect(() => loadConfig(baseEnv({ APPROVAL_JWT_SECRET: shortSecret }))).toThrow();
  });

  it('fails fast when a required env var is missing', () => {
    const env = baseEnv();
    delete env.CUBE_NFT_NETWORK;

    expect(() => loadConfig(env)).toThrow();
  });

  it('fails fast when DATABASE_URL is missing', () => {
    const env = baseEnv();
    delete env.DATABASE_URL;

    expect(() => loadConfig(env)).toThrow();
  });

  it('rejects a deployment artifact with an invalid chainId', () => {
    expect(() => loadConfig(baseEnv({ CUBE_NFT_NETWORK: 'invalid-chainid' }))).toThrow();
  });

  it('rejects a deployment artifact with an invalid address', () => {
    expect(() => loadConfig(baseEnv({ CUBE_NFT_NETWORK: 'invalid-address' }))).toThrow();
  });

  it('rejects a deployment artifact that does not exist', () => {
    expect(() => loadConfig(baseEnv({ CUBE_NFT_NETWORK: 'does-not-exist' }))).toThrow();
  });
});
