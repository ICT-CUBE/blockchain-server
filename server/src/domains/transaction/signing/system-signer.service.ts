import { Injectable } from '@nestjs/common';
import { getAddress, Wallet } from 'ethers';

import { AppConfigService } from '../../../shared/config/app-config.service';

/** Which `CubeNFT` role a transaction is signed for — distinct from user custodial wallets
 * (TASK-05): these are ARZONE-operated keys. `mint` holds `MINTER_ROLE`; `relayer` holds
 * `AUTHORIZED_TRANSFER_ROLE`, used for every Transfer/Withdrawal/Reentry/External Resale
 * `authorizedTransfer` call (TASK-07 §6, TASK-08/09 §5/§8). */
export type SystemSignerRole = 'mint' | 'relayer';

/** Holds the two ARZONE-operated signer keys as offline `ethers.Wallet`s (no provider attached —
 * signing and broadcasting are deliberately separate steps here, see `TransactionSubmissionService`
 * and `RpcService`). */
@Injectable()
export class SystemSignerService {
  private readonly wallets: Record<SystemSignerRole, Wallet>;

  constructor(appConfig: AppConfigService) {
    const { signers } = appConfig.submission;
    this.wallets = {
      mint: new Wallet(signers.mintSignerPrivateKey),
      relayer: new Wallet(signers.relayerSignerPrivateKey),
    };
  }

  addressFor(role: SystemSignerRole): string {
    return this.wallets[role].address;
  }

  walletFor(role: SystemSignerRole): Wallet {
    return this.wallets[role];
  }

  /** Reverses `addressFor` — used when recovering a `TransactionAttempt` (which only stores the
   * resolved `signerAddress`) back to the role needed to build a fee-bump replacement. */
  roleForAddress(address: string): SystemSignerRole {
    const normalized = getAddress(address);
    const match = (Object.keys(this.wallets) as SystemSignerRole[]).find(
      (role) => this.wallets[role].address === normalized,
    );
    if (!match) {
      throw new Error(`No system signer role for address ${normalized}`);
    }
    return match;
  }
}
