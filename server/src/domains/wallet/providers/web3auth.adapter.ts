import { Injectable, Logger } from '@nestjs/common';
import { BrowserProvider } from 'ethers';
import jwt from 'jsonwebtoken';

// Type-only imports are erased at compile time and never trigger module loading at runtime, so
// they're safe to keep static. The actual SDK class/value is loaded lazily via dynamic `import()`
// inside `ensureInitialized()` below — see the comment there for why that matters.
import type { Web3Auth as Web3AuthType, Web3AuthOptions } from '@web3auth/node-sdk';
import type { CustomChainConfig } from '@web3auth/no-modal';

// `CHAIN_NAMESPACES.EIP155` is just the literal "eip155" (verified against
// @toruslabs/base-controllers's INetworkController.js, which @web3auth/no-modal re-exports from) —
// using the literal directly avoids importing @web3auth/no-modal's runtime module at all.
const EIP155: CustomChainConfig['chainNamespace'] = 'eip155';

import type { AppConfig } from '../../../shared/config/app-config';
import { AppConfigService } from '../../../shared/config/app-config.service';
import type {
  CustodialWalletPort,
  ProvisionedWallet,
  SignTransactionRequest,
  SignTypedDataRequest,
} from '../application/custodial-wallet.port';

/** Thrown by every method when `AppConfigService.web3Auth` is missing the pieces this adapter
 * needs to actually call Web3Auth — see TASK-05 §13/§14: real integration is not claimed complete
 * until these exist and a live `connect()` has been verified, however correct the code path is. */
export class Web3AuthNotConfiguredError extends Error {
  constructor(missing: string) {
    super(
      `Web3Auth adapter is selected but not fully configured: missing ${missing}. ` +
        'Set WEB3AUTH_AUTH_CONNECTION_ID (the Custom Auth Connection configured in the Web3Auth ' +
        'dashboard) and WEB3AUTH_JWT_SIGNING_PRIVATE_KEY (the ES256 private key whose public JWKS ' +
        'that Auth Connection trusts), or switch CUSTODIAL_WALLET_PROVIDER back to "fake".',
    );
    this.name = 'Web3AuthNotConfiguredError';
  }
}

/**
 * Real adapter over `@web3auth/node-sdk`'s server-driven MPC flow: mint a short-lived self-signed
 * ES256 "Custom JWT" for `userId`, exchange it via `connect({ authConnectionId, idToken, userId })`
 * for that user's wallet, and sign through the returned EIP-1193 provider (wrapped in an ethers
 * `BrowserProvider` so the rest of the codebase never touches Web3Auth/viem types directly).
 *
 * `init()`-only connectivity (client id + network, no auth) has been verified live against the
 * real project. The full `connect()` path is implemented per the SDK's documented "Bring your own
 * JWT" contract but has **not** been exercised end-to-end — that needs `WEB3AUTH_AUTH_CONNECTION_ID`
 * from the Web3Auth dashboard (a Custom Auth Connection configured to trust this adapter's JWKS),
 * which is outside this codebase (TASK-05 §14).
 */
@Injectable()
export class Web3AuthAdapter implements CustodialWalletPort {
  readonly providerName = 'web3auth';

  private readonly logger = new Logger(Web3AuthAdapter.name);
  private readonly config: AppConfig['web3Auth'];
  // Both the SDK client itself and its `init()` are built lazily, on first real use — not in the
  // constructor. Nest instantiates every listed provider at boot regardless of which one the
  // CUSTODIAL_WALLET_PORT factory ends up selecting, so this adapter must stay fully inert
  // (construct nothing, call nothing) whenever the bound provider is actually "fake".
  private client: Web3AuthType | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(appConfig: AppConfigService) {
    this.config = appConfig.web3Auth;
  }

  async getOrCreateWallet(userId: string): Promise<ProvisionedWallet> {
    const provider = await this.connectAsUser(userId);
    const ethersProvider = new BrowserProvider(provider);
    const signer = await ethersProvider.getSigner();
    const address = await signer.getAddress();
    return { address, providerRef: userId };
  }

  async signTransaction(request: SignTransactionRequest): Promise<string> {
    const provider = await this.connectAsUser(request.userId);
    const ethersProvider = new BrowserProvider(provider);
    const signer = await ethersProvider.getSigner();
    return signer.signTransaction({
      to: request.transaction.to,
      data: request.transaction.data,
      value: BigInt(request.transaction.value),
      nonce: request.transaction.nonce,
      chainId: request.chainId,
      maxFeePerGas: BigInt(request.transaction.maxFeePerGas),
      maxPriorityFeePerGas: BigInt(request.transaction.maxPriorityFeePerGas),
      gasLimit: BigInt(request.transaction.gasLimit),
      type: 2,
    });
  }

  async signTypedData(request: SignTypedDataRequest): Promise<string> {
    const provider = await this.connectAsUser(request.userId);
    const ethersProvider = new BrowserProvider(provider);
    const signer = await ethersProvider.getSigner();
    return signer.signTypedData(request.domain, request.types, request.value);
  }

  private async connectAsUser(userId: string) {
    const client = await this.ensureInitialized();
    const idToken = this.mintIdToken(userId);
    const result = await client.connect({
      authConnectionId: this.requireAuthConnectionId(),
      idToken,
      userId,
    });
    if (result.chainNamespace !== EIP155) {
      throw new Error(`Unexpected Web3Auth chainNamespace "${result.chainNamespace}", expected eip155`);
    }
    return result.provider;
  }

  private async ensureInitialized(): Promise<Web3AuthType> {
    if (!this.config.clientId || !this.config.rpcTarget) {
      throw new Web3AuthNotConfiguredError('WEB3AUTH_CLIENT_ID/WEB3AUTH_RPC_TARGET');
    }
    if (!this.client) {
      // Deliberately dynamic: @web3auth/node-sdk's dependency tree includes ESM-only packages
      // (e.g. @toruslabs/metadata-helpers) that crash Jest's CJS `require()` loader if pulled in via
      // a static top-level import — even though this class only ever reaches this line when the
      // "web3auth" adapter is actually selected and actually invoked. A dynamic import() defers
      // that module graph load to first real use, at which point Node's own ESM interop handles it
      // (ts-jest/CommonJS transpiles `import()` to a real dynamic `import()`, not `require()`).
      const { Web3Auth } = await import('@web3auth/node-sdk');
      this.client = new Web3Auth({
        clientId: this.config.clientId,
        // Our own config keeps this as a plain string (env-driven, forward-compatible with new
        // network names Web3Auth adds) rather than importing their literal union type app-wide.
        web3AuthNetwork: this.config.network as Web3AuthOptions['web3AuthNetwork'],
        chains: [
          {
            chainNamespace: EIP155,
            displayName: 'Polygon Amoy',
            blockExplorerUrl: 'https://amoy.polygonscan.com',
            ticker: 'POL',
            tickerName: 'POL',
            chainId: `0x${this.config.chainId.toString(16)}`,
            rpcTarget: this.config.rpcTarget,
            logo: 'https://images.web3auth.io/login-polygon.svg',
          },
        ],
      });
    }
    const client = this.client;
    this.initPromise ??= client.init().catch((error: unknown) => {
      this.initPromise = null;
      throw error;
    });
    await this.initPromise;
    return client;
  }

  private requireAuthConnectionId(): string {
    if (!this.config.authConnectionId) {
      throw new Web3AuthNotConfiguredError('WEB3AUTH_AUTH_CONNECTION_ID');
    }
    return this.config.authConnectionId;
  }

  /** Self-signs a short-lived "Custom JWT" per Web3Auth's documented Bring-your-own-JWT flow: our
   * own ES256 keypair, `sub`/`userId` fields the Auth Connection is configured to read, and our
   * JWKS (derived from the same key) is what that Auth Connection must be configured to trust. */
  private mintIdToken(userId: string): string {
    if (!this.config.jwtSigningPrivateKey) {
      throw new Web3AuthNotConfiguredError('WEB3AUTH_JWT_SIGNING_PRIVATE_KEY');
    }
    this.logger.debug(`Minting a Web3Auth idToken for userId=${userId}`);
    return jwt.sign({ sub: userId, userId }, this.config.jwtSigningPrivateKey, {
      algorithm: 'ES256',
      expiresIn: '5m',
      keyid: this.config.jwtSigningKeyId ?? undefined,
    });
  }
}
