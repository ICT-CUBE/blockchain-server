import { randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import { WalletService } from '../../src/domains/wallet/application/wallet.service';
import { FakeWeb3AuthAdapter } from '../../src/domains/wallet/providers/fake-web3auth.adapter';
import { createTestDataSource } from './test-data-source';

describe('WalletService (integration)', () => {
  let dataSource: DataSource;
  let walletService: WalletService;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    walletService = new WalletService(new FakeWeb3AuthAdapter(), dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('provisions a new wallet on first call and reuses it on every later call for the same userId', async () => {
    const userId = `user-${randomUUID()}`;

    const first = await walletService.getOrCreate(userId);
    const second = await walletService.getOrCreate(userId);

    expect(second.id).toBe(first.id);
    expect(second.address).toBe(first.address);
    expect(first.provider).toBe('fake-web3auth');
  });

  it('gives different users different wallets', async () => {
    const walletA = await walletService.getOrCreate(`user-${randomUUID()}`);
    const walletB = await walletService.getOrCreate(`user-${randomUUID()}`);
    expect(walletA.address).not.toBe(walletB.address);
  });

  it('resolves a race between concurrent getOrCreate calls for the same new userId to one wallet', async () => {
    const userId = `user-${randomUUID()}`;

    const results = await Promise.all(Array.from({ length: 5 }, () => walletService.getOrCreate(userId)));

    const distinctIds = new Set(results.map((w) => w.id));
    expect(distinctIds.size).toBe(1);
  });

  it('findByUserId returns null for a userId that was never provisioned', async () => {
    const result = await walletService.findByUserId(`user-${randomUUID()}`);
    expect(result).toBeNull();
  });

  it('reports the fake adapter as not integration-ready', () => {
    expect(walletService.isIntegrationReady).toBe(false);
    expect(walletService.providerName).toBe('fake-web3auth');
  });
});
