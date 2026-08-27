import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Transaction, Wallet } from 'ethers';

import type {
  CustodialWalletPort,
  ProvisionedWallet,
  SignTransactionRequest,
  SignTypedDataRequest,
} from '../application/custodial-wallet.port';

const FAKE_ADAPTER_PROVIDER_NAME = 'fake-web3auth';

/**
 * Deterministic, in-process stand-in for the real Web3Auth adapter. Derives a private key from
 * `userId` via `keccak256("fake-web3auth-dev-key:" + userId)` so the same `userId` always maps to
 * the same address (matching what a real MPC provider's deterministic derivation would look like),
 * and actually produces valid, recoverable signatures — useful for every other task that needs a
 * working signer locally without Web3Auth credentials.
 *
 * This is explicitly **not** MPC and **not** a security boundary: the "key" is fully derivable by
 * anyone who knows this scheme. `provider` is set to `"fake-web3auth"` (not `"web3auth"`) precisely
 * so nothing downstream can mistake a fake-adapter wallet for one backed by real custody — see
 * `WalletService.isIntegrationReady`. Never bind this adapter outside local/test use.
 */
@Injectable()
export class FakeWeb3AuthAdapter implements CustodialWalletPort {
  private readonly logger = new Logger(FakeWeb3AuthAdapter.name);

  readonly providerName = FAKE_ADAPTER_PROVIDER_NAME;
  static readonly providerName = FAKE_ADAPTER_PROVIDER_NAME;

  async getOrCreateWallet(userId: string): Promise<ProvisionedWallet> {
    const wallet = this.deriveWallet(userId);
    this.logger.debug(`Fake-provisioned wallet for userId=${userId}`);
    return Promise.resolve({ address: wallet.address, providerRef: `fake:${userId}` });
  }

  async signTransaction(request: SignTransactionRequest): Promise<string> {
    const wallet = this.deriveWallet(request.userId);
    const signed = await wallet.signTransaction({
      type: 2,
      chainId: request.chainId,
      to: request.transaction.to,
      data: request.transaction.data,
      value: BigInt(request.transaction.value),
      nonce: request.transaction.nonce,
      maxFeePerGas: BigInt(request.transaction.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(request.transaction.maxPriorityFeePerGas),
      gasLimit: BigInt(request.transaction.gasLimit),
    });
    // Cheap self-check: the recovered signer must be this wallet's own address.
    const recovered = Transaction.from(signed).from;
    if (recovered?.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        'Fake adapter produced a transaction signature that does not recover to its own address',
      );
    }
    return signed;
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    const wallet = this.deriveWallet(request.userId);
    return wallet.signTypedData(request.domain, request.types, request.value);
  }

  private deriveWallet(userId: string): Wallet {
    const privateKey = createHash('sha256').update(`fake-web3auth-dev-key:${userId}`, 'utf8').digest();
    return new Wallet(`0x${privateKey.toString('hex')}`);
  }
}
