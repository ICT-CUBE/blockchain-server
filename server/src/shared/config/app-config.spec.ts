import path from 'node:path';

import { loadConfig } from './app-config';

const FIXTURES_DIR = path.join(__dirname, '..', '..', '..', 'test', 'fixtures', 'deployments');

function baseEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    PORT: '3000',
    CUBE_NFT_NETWORK: 'localhost',
    CUBE_NFT_DEPLOYMENTS_DIR: FIXTURES_DIR,
    DATABASE_URL: 'mysql://user:pass@127.0.0.1:3306/cube_nft_test',
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
