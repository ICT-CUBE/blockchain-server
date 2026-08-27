import { Transaction, verifyTypedData } from 'ethers';

import { FakeWeb3AuthAdapter } from './fake-web3auth.adapter';

describe('FakeWeb3AuthAdapter', () => {
  const adapter = new FakeWeb3AuthAdapter();

  it('returns the same address for the same userId every time', async () => {
    const first = await adapter.getOrCreateWallet('user-1');
    const second = await adapter.getOrCreateWallet('user-1');
    expect(second.address).toBe(first.address);
  });

  it('returns different addresses for different userIds', async () => {
    const a = await adapter.getOrCreateWallet('user-a');
    const b = await adapter.getOrCreateWallet('user-b');
    expect(a.address).not.toBe(b.address);
  });

  it('never exposes anything resembling a private key in the provisioned wallet', async () => {
    const wallet = await adapter.getOrCreateWallet('user-secret-check');
    const values = Object.values(wallet);
    for (const value of values) {
      // A raw private key is 66 chars (0x + 64 hex); reject anything that long-and-hex-shaped.
      expect(typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)).toBe(false);
    }
  });

  it('signTransaction produces a signature that recovers to the wallet own address', async () => {
    const wallet = await adapter.getOrCreateWallet('user-tx');
    const signed = await adapter.signTransaction({
      userId: 'user-tx',
      chainId: 80002,
      transaction: {
        to: '0x1111111111111111111111111111111111111111',
        data: '0x',
        value: '0',
        nonce: 0,
        maxFeePerGas: '30000000000',
        maxPriorityFeePerGas: '30000000000',
        gasLimit: '100000',
      },
      purpose: 'MINT',
    });

    const recovered = Transaction.from(signed).from;
    expect(recovered?.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it('signTypedData produces a signature that recovers to the wallet own address', async () => {
    const wallet = await adapter.getOrCreateWallet('user-typed');
    const domain = { name: 'Test', version: '1', chainId: 80002, verifyingContract: wallet.address };
    const types = { Ping: [{ name: 'value', type: 'uint256' }] };
    const value = { value: 42n };

    const signature = await adapter.signTypedData({
      userId: 'user-typed',
      domain,
      types,
      value,
      purpose: 'MINT',
    });

    const recovered = verifyTypedData(domain, types, value, signature);
    expect(recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
  });
});
