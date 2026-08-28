import { Inject, Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { AuditWriter } from '../../audit/application/audit-writer';
import { FailureCode } from '../../audit/persistence/failure-record.entity';
import { Operation } from '../../operation/persistence/operation.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { describeRpcError } from '../../transaction/rpc/rpc-error';
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

/**
 * TASK-08 §5's worker half: polls REQUESTED Transfer Operations. For each, re-verifies the current
 * owner right before submitting (the *mandatory* "제출 직전 owner 재검증", TASK-07/08 §12), mints a
 * fresh `OwnerConsent` signed by the seller's own custodial wallet, and submits
 * `authorizedTransfer` through the ARZONE relayer (`AUTHORIZED_TRANSFER_ROLE`).
 *
 * 검증 D2: an Operation this worker did not actually put on chain is never marked
 * ONCHAIN_CONFIRMED. If the token is no longer with the seller by the time we get here — even if it
 * is already with the buyer — that is an owner conflict for a human to look at, not a silent success.
 */
@Injectable()
export class TransferWorker extends IntervalWorker {
  protected readonly logger = new Logger(TransferWorker.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly walletService: WalletService,
    @Inject(TRANSACTION_SUBMISSION_PORT) private readonly submission: TransactionSubmissionPort,
    private readonly appConfig: AppConfigService,
    private readonly auditWriter: AuditWriter,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.submission.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const operations = await this.dataSource.getRepository(Operation).find({
      where: { type: OperationType.TRANSFER, status: OperationStatus.REQUESTED },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    for (const operation of operations) {
      try {
        await this.process(operation);
      } catch (error) {
        this.logger.warn(
          `Transfer processing failed for operation ${operation.id}: ${describeRpcError(error)}`,
        );
      }
    }
  }

  private async process(operation: Operation): Promise<void> {
    if (!operation.fromAddress || !operation.toAddress) {
      // Unprocessable row — park it rather than throwing every tick and starving the batch.
      await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'INVALID_OPERATION_DATA');
      return;
    }
    const expectedFrom = getAddress(operation.fromAddress);
    const expectedTo = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);
    if (!actualOwner || getAddress(actualOwner) !== expectedFrom) {
      await this.flagOwnerConflict(operation, actualOwner, expectedTo);
      return;
    }

    const sellerWallet = await this.findWalletByAddress(expectedFrom);
    if (!sellerWallet) {
      throw new Error(`No custodial wallet on file resolves to seller address ${expectedFrom}`);
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
      purpose: OwnerConsentPurpose.TRANSFER,
      nonce,
      deadline,
    };

    const signature = await this.walletService.signTypedData(
      sellerWallet.userId,
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      consent,
      OperationType.TRANSFER,
    );

    const data = encodeAuthorizedTransfer(consent, signature);

    await this.submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'relayer',
      to: proxyAddress,
      data,
    });

    await this.transitionQuietly(operation.id, OperationStatus.SUBMITTED, 'TRANSFER_SUBMITTED');
  }

  private async findWalletByAddress(address: string): Promise<WalletAccount | null> {
    return this.dataSource.getRepository(WalletAccount).findOne({ where: { address } });
  }

  /** The current owner is not the expected seller — a data-integrity concern, not something to
   * retry automatically, and not a success even when the holder happens to be the buyer. */
  private async flagOwnerConflict(
    operation: Operation,
    actualOwner: string | null,
    expectedTo: string,
  ): Promise<void> {
    const alreadyAtDestination = actualOwner !== null && getAddress(actualOwner) === expectedTo;
    await this.transitionQuietly(
      operation.id,
      OperationStatus.REVIEW_REQUIRED,
      alreadyAtDestination ? 'OWNER_ALREADY_AT_DESTINATION' : 'OWNER_MISMATCH_AT_SUBMIT',
    );
    await this.auditWriter
      .writeFailure({
        code: FailureCode.OWNER_MISMATCH,
        operationId: operation.id,
        details: {
          expectedFrom: operation.fromAddress,
          expectedTo: operation.toAddress,
          actualOwner,
          alreadyAtDestination,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Failure-record write failed for operation ${operation.id}: ${(error as Error).message}`,
        );
      });
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
