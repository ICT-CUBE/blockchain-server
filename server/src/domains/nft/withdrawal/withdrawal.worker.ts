import { Inject, Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { Operation } from '../../operation/persistence/operation.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import {
  encodeAuthorizedTransfer,
  ownerConsentDomain,
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
} from '../../transaction/signing/owner-consent';
import {
  TRANSACTION_SUBMISSION_PORT,
  type TransactionSubmissionPort,
} from '../../transaction/submission/transaction-submission.port';
import { WalletService } from '../../wallet/application/wallet.service';
import { WalletAccount } from '../../wallet/persistence/wallet-account.entity';

const BATCH_SIZE = 20;

/** TASK-09 §5's Withdrawal worker: same shape as `TransferWorker`, purpose WITHDRAWAL — the
 * custodial wallet signs its own consent to move the token to the user's external address. */
@Injectable()
export class WithdrawalWorker extends IntervalWorker {
  protected readonly logger = new Logger(WithdrawalWorker.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly walletService: WalletService,
    @Inject(TRANSACTION_SUBMISSION_PORT) private readonly submission: TransactionSubmissionPort,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.submission.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const operations = await this.dataSource.getRepository(Operation).find({
      where: { type: OperationType.WITHDRAWAL, status: OperationStatus.REQUESTED },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    for (const operation of operations) {
      try {
        await this.process(operation);
      } catch (error) {
        this.logger.warn(
          `Withdrawal processing failed for operation ${operation.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async process(operation: Operation): Promise<void> {
    if (!operation.fromAddress || !operation.toAddress) {
      throw new Error(`Withdrawal operation ${operation.id} is missing from/to`);
    }
    const expectedFrom = getAddress(operation.fromAddress);
    const expectedTo = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);

    if (actualOwner && getAddress(actualOwner) === expectedTo) {
      await this.transitionQuietly(
        operation.id,
        OperationStatus.ONCHAIN_CONFIRMED,
        'ALREADY_WITHDRAWN_IDEMPOTENT',
      );
      await this.assetLockRepository.release(operation.tokenId);
      return;
    }

    if (!actualOwner || getAddress(actualOwner) !== expectedFrom) {
      await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'OWNER_MISMATCH_AT_SUBMIT');
      return;
    }

    const custodialWallet = await this.dataSource
      .getRepository(WalletAccount)
      .findOne({ where: { address: expectedFrom } });
    if (!custodialWallet) {
      throw new Error(`No custodial wallet on file resolves to address ${expectedFrom}`);
    }

    const chainId = this.appConfig.cubeNft.deployment.chainId;
    const proxyAddress = this.appConfig.cubeNft.deployment.proxyAddress;
    const nonce = await this.cubeNftReader.consentNonce(operation.tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.appConfig.ownerConsent.deadlineSeconds);

    const consent = {
      tokenId: operation.tokenId,
      currentOwner: expectedFrom,
      from: expectedFrom,
      to: expectedTo,
      purpose: OwnerConsentPurpose.WITHDRAWAL,
      nonce,
      deadline,
    };

    const signature = await this.walletService.signTypedData(
      custodialWallet.userId,
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      consent,
      OperationType.WITHDRAWAL,
    );

    const data = encodeAuthorizedTransfer(consent, signature);

    await this.submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'relayer',
      to: proxyAddress,
      data,
    });

    await this.transitionQuietly(operation.id, OperationStatus.SUBMITTED, 'WITHDRAWAL_SUBMITTED');
  }

  private async transitionQuietly(
    operationId: string,
    nextStatus: OperationStatus,
    reason: string,
  ): Promise<void> {
    try {
      await this.operationRepository.transition(operationId, OperationStatus.REQUESTED, nextStatus, reason);
    } catch {
      // Already moved by a concurrent pass — nothing left to do.
    }
  }
}
