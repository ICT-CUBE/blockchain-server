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
import { encodeAuthorizedTransfer, OwnerConsentPurpose } from '../../transaction/signing/owner-consent';
import {
  TRANSACTION_SUBMISSION_PORT,
  type TransactionSubmissionPort,
} from '../../transaction/submission/transaction-submission.port';

const BATCH_SIZE = 20;

interface ExternalResaleMetadata {
  tradeId: string;
  consentNonce: string;
  consentDeadline: string;
  externalSignature: string;
}

function isExternalResaleMetadata(value: unknown): value is ExternalResaleMetadata {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<ExternalResaleMetadata>).consentNonce === 'string' &&
    typeof (value as Partial<ExternalResaleMetadata>).consentDeadline === 'string' &&
    typeof (value as Partial<ExternalResaleMetadata>).externalSignature === 'string'
  );
}

/** TASK-09 §5's External-Resale worker — structurally identical to `ReentryWorker` (resubmits a
 * pre-signed external `OwnerConsent` unchanged), except the destination is the buyer's custodial
 * wallet rather than the same user's. */
@Injectable()
export class ExternalResaleWorker extends IntervalWorker {
  protected readonly logger = new Logger(ExternalResaleWorker.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly cubeNftReader: CubeNftReaderService,
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
      where: { type: OperationType.EXTERNAL_RESALE, status: OperationStatus.REQUESTED },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    for (const operation of operations) {
      try {
        await this.process(operation);
      } catch (error) {
        this.logger.warn(
          `External resale processing failed for operation ${operation.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async process(operation: Operation): Promise<void> {
    if (!operation.fromAddress || !operation.toAddress) {
      throw new Error(`External resale operation ${operation.id} is missing from/to`);
    }
    if (!isExternalResaleMetadata(operation.metadata)) {
      throw new Error(
        `External resale operation ${operation.id} is missing its stored consent/signature metadata`,
      );
    }
    const expectedFrom = getAddress(operation.fromAddress);
    const expectedTo = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);

    if (actualOwner && getAddress(actualOwner) === expectedTo) {
      await this.transitionQuietly(
        operation.id,
        OperationStatus.ONCHAIN_CONFIRMED,
        'ALREADY_RESOLD_IDEMPOTENT',
      );
      await this.assetLockRepository.release(operation.tokenId);
      return;
    }

    if (!actualOwner || getAddress(actualOwner) !== expectedFrom) {
      await this.flagOwnerConflict(operation, actualOwner);
      return;
    }

    const chainId = this.appConfig.cubeNft.deployment.chainId;
    const proxyAddress = this.appConfig.cubeNft.deployment.proxyAddress;

    const consent = {
      tokenId: operation.tokenId,
      currentOwner: expectedFrom,
      from: expectedFrom,
      to: expectedTo,
      purpose: OwnerConsentPurpose.EXTERNAL_RESALE,
      nonce: BigInt(operation.metadata.consentNonce),
      deadline: BigInt(operation.metadata.consentDeadline),
    };

    if (consent.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'CONSENT_EXPIRED');
      return;
    }

    const data = encodeAuthorizedTransfer(consent, operation.metadata.externalSignature);

    try {
      await this.submission.submit({
        operationId: operation.id,
        chainId,
        signerRole: 'relayer',
        to: proxyAddress,
        data,
      });
    } catch (error) {
      await this.transitionQuietly(
        operation.id,
        OperationStatus.REVIEW_REQUIRED,
        'CONSENT_REJECTED_ON_SUBMIT',
      );
      throw error;
    }

    await this.transitionQuietly(operation.id, OperationStatus.SUBMITTED, 'EXTERNAL_RESALE_SUBMITTED');
  }

  /** The current owner is neither the expected sender nor the expected buyer — a data-integrity
   * concern, not something to retry automatically. */
  private async flagOwnerConflict(operation: Operation, actualOwner: string | null): Promise<void> {
    await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'OWNER_MISMATCH_AT_SUBMIT');
    await this.auditWriter
      .writeFailure({
        code: FailureCode.OWNER_MISMATCH,
        operationId: operation.id,
        details: { expectedFrom: operation.fromAddress, expectedTo: operation.toAddress, actualOwner },
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
