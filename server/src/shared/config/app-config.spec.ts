import path from 'node:path';

import { loadConfig } from './app-config';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'deployments');

/** A valid base64url secret (>=32 raw bytes) for tests only — never a real key. */
const TEST_SECRET_A = Buffer.alloc(32, 1).toString('base64url');
const TEST_SECRET_B = Buffer.alloc(32, 2).toString('base64url');
const TEST_RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
const TEST_MINT_SIGNER_PRIVATE_KEY = `0x${'4'.repeat(64)}`;
const TEST_RELAYER_SIGNER_PRIVATE_KEY = `0x${'5'.repeat(64)}`;

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    CUBE_NFT_NETWORK: 'localhost',
    CUBE_NFT_DEPLOYMENTS_DIR: FIXTURES_DIR,
    DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/cube_nft_test',
    HMAC_INBOUND_KEY_ID: 'backend-v1',
    HMAC_INBOUND_KEY_SECRET: TEST_SECRET_A,
    HMAC_OPERATOR_KEY_ID: 'operator-v1',
    HMAC_OPERATOR_KEY_SECRET: Buffer.alloc(32, 5).toString('base64url'),
    APPROVAL_JWT_SECRET: TEST_SECRET_B,
    APPROVAL_JWT_ISSUER: 'arzone-backend',
    APPROVAL_JWT_AUDIENCE: 'arzone-blockchain-server',
    RAW_TX_ENCRYPTION_KEY: TEST_RAW_TX_ENCRYPTION_KEY,
    TRANSACTION_RPC_URL_PRIMARY: 'http://127.0.0.1:8545',
    MINT_SIGNER_PRIVATE_KEY: TEST_MINT_SIGNER_PRIVATE_KEY,
    RELAYER_SIGNER_PRIVATE_KEY: TEST_RELAYER_SIGNER_PRIVATE_KEY,
    NOTIFICATION_CALLBACK_URL: 'http://127.0.0.1:4100/webhook',
    HMAC_OUTBOUND_KEY_ID: 'outbound-v1',
    HMAC_OUTBOUND_KEY_SECRET: Buffer.alloc(32, 4).toString('base64url'),
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
    expect(config.submission.rpc.primaryUrl).toBe('http://127.0.0.1:8545');
    expect(config.submission.signers.mintSignerPrivateKey).toBe(TEST_MINT_SIGNER_PRIVATE_KEY);
    expect(config.submission.rawTxEncryptionKey).toEqual(Buffer.from(TEST_RAW_TX_ENCRYPTION_KEY, 'base64'));
    expect(config.confirmation.blocksRequired).toBe(5);
    expect(config.logging.level).toBe('log');
    expect(config.audit.longPendingThresholdMs).toBe(30 * 60 * 1000);
    expect(config.hmacOperator.current.keyId).toBe('operator-v1');
    expect(config.hmacOperator.previous).toBeNull();
  });

  it('falls back to well-known Hardhat dev signers/RPC on a local network (localhost included, mirroring deploy.ts)', () => {
    const env = baseEnv({ CUBE_NFT_NETWORK: 'localhost' });
    delete env.TRANSACTION_RPC_URL_PRIMARY;
    delete env.MINT_SIGNER_PRIVATE_KEY;
    delete env.RELAYER_SIGNER_PRIVATE_KEY;

    const config = loadConfig(env);
    expect(config.submission.rpc.primaryUrl).toBe('http://127.0.0.1:8545');
    expect(config.submission.signers.mintSignerPrivateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('still fails fast on a non-local network when RPC/signer config is omitted', () => {
    // 'remote-fixture' has a deployment artifact but is not a LOCAL_NETWORK_NAMES entry, so the
    // refine rules must reject the missing values rather than silently fall back.
    const env = baseEnv({ CUBE_NFT_NETWORK: 'remote-fixture' });
    delete env.TRANSACTION_RPC_URL_PRIMARY;
    delete env.MINT_SIGNER_PRIVATE_KEY;
    delete env.RELAYER_SIGNER_PRIVATE_KEY;

    expect(() => loadConfig(env)).toThrow();
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
