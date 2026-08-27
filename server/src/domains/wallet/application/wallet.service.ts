import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { getAddress, type TypedDataDomain, type TypedDataField } from 'ethers';
import { DataSource, QueryFailedError } from 'typeorm';

import { WalletAccount, WalletAccountStatus } from '../persistence/wallet-account.entity';
import { CUSTODIAL_WALLET_PORT, type CustodialWalletPort } from './custodial-wallet.port';

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof error.driverError === 'object' &&
    error.driverError !== null &&
    'code' in error.driverError &&
    (error.driverError as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * The one place the rest of the server asks "what is this user's custodial wallet" (TASK-05 §4).
 * `getOrCreate` checks the DB first — the bound `CustodialWalletPort` is only ever called to
 * provision a wallet the first time a `userId` is seen, never on every lookup.
 */
@Injectable()
export class WalletService {
  constructor(
    @Inject(CUSTODIAL_WALLET_PORT) private readonly walletPort: CustodialWalletPort,
    private readonly dataSource: DataSource,
  ) {}

  /** True only when the bound adapter is real custody, not the local fake — TASK-05 §5/§13: work
   * done against the fake adapter is real, tested code, but is not "실제 integration 완료" until a
   * real Web3Auth adapter with real credentials is bound instead. */
  get isIntegrationReady(): boolean {
    return this.walletPort.providerName !== 'fake-web3auth';
  }

  get providerName(): string {
    return this.walletPort.providerName;
  }

  /** Returns the existing wallet for `userId`, or provisions one via the bound
   * `CustodialWalletPort` and persists it. On a unique-constraint race between two concurrent
   * callers for the same new `userId`, re-reads and returns the winner's row rather than erroring
   * (TASK-05 §5: "unique userId 충돌 시 재조회"). Never persists a key, key share, or provider
   * token — only the checksum-normalized address and an opaque `providerRef`. */
  async getOrCreate(userId: string): Promise<WalletAccount> {
    const repository = this.dataSource.getRepository(WalletAccount);

    const existing = await repository.findOne({ where: { userId } });
    if (existing) {
      return existing;
    }

    const provisioned = await this.walletPort.getOrCreateWallet(userId);
    const address = getAddress(provisioned.address);

    const record = repository.create({
      id: randomUUID(),
      userId,
      address,
      provider: this.walletPort.providerName,
      providerRef: provisioned.providerRef,
      status: WalletAccountStatus.ACTIVE,
    });

    try {
      await repository.insert(record);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      return repository.findOneOrFail({ where: { userId } });
    }

    return record;
  }

  async findByUserId(userId: string): Promise<WalletAccount | null> {
    return this.dataSource.getRepository(WalletAccount).findOne({ where: { userId } });
  }

  /** Signs EIP-712 typed data (e.g. an `OwnerConsent`, TASK-08/09) as `userId`'s custodial wallet.
   * Thin pass-through to the bound `CustodialWalletPort` — this is the only place outside that port
   * itself that touches signing, keeping the "never expose arbitrary raw signing" rule (TASK-05
   * §5) centralized in one adapter contract rather than duplicated per caller. */
  async signTypedData(
    userId: string,
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, unknown>,
    purpose: string,
  ): Promise<string> {
    return this.walletPort.signTypedData({ userId, domain, types, value, purpose });
  }
}
