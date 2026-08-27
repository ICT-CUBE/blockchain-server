import type { TypedDataDomain, TypedDataField } from 'ethers';

/** DI token for `CustodialWalletPort` — interfaces have no runtime value, so a plain class/symbol
 * token stands in for `@Inject()`. Bound to `FakeWeb3AuthAdapter` until real Web3Auth credentials
 * exist (TASK-05 §13); bound to the real adapter after. */
export const CUSTODIAL_WALLET_PORT = Symbol('CUSTODIAL_WALLET_PORT');

export interface ProvisionedWallet {
  address: string;
  /** Opaque provider-side reference (e.g. a Web3Auth user/wallet id) — never a key or key share. */
  providerRef: string;
}

export interface SignTransactionRequest {
  userId: string;
  chainId: number;
  transaction: {
    to: string;
    data: string;
    value: string;
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gasLimit: string;
  };
  /** Which approved operation this signature is for. The port must refuse to sign anything not
   * tied to a recognized purpose — it never exposes arbitrary raw signing (TASK-05 §5: "operation
   * context와 허용 목적을 받아 임의 raw signing을 도메인 밖에 노출하지 않는다"). */
  purpose: string;
}

export interface SignTypedDataRequest {
  userId: string;
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  value: Record<string, unknown>;
  purpose: string;
}

/**
 * The only thing the rest of the server knows about custodial wallets. `WalletService` is the sole
 * caller — nothing else in the codebase is allowed to depend on a concrete adapter, so swapping
 * `FakeWeb3AuthAdapter` for a real Web3Auth adapter later touches only this port's binding, not any
 * consumer (TASK-05 §4).
 */
export interface CustodialWalletPort {
  /** Stored on `WalletAccount.provider` for every wallet this adapter provisions, and used by
   * `WalletService.isIntegrationReady` to tell a real-custody wallet apart from a fake-adapter one
   * (TASK-05 §5: "credential 누락 시 readiness가 실제 integration 미준비를 표시한다"). */
  readonly providerName: string;

  /** Idempotent at the provider level: repeated calls for the same `userId` return the same
   * wallet. `WalletService` still checks the DB first so this is only called once per new user. */
  getOrCreateWallet(userId: string): Promise<ProvisionedWallet>;

  /** Signs an EVM transaction. Returns the signed raw transaction hex. */
  signTransaction(request: SignTransactionRequest): Promise<string>;

  /** Signs EIP-712 typed data (e.g. an `OwnerConsent`). Returns the signature hex. */
  signTypedData(request: SignTypedDataRequest): Promise<string>;
}
