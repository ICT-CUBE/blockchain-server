import { Logger } from '@nestjs/common';
import { getAddress } from 'ethers';
import { DataSource, type QueryDeepPartialEntity } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import type { OperationType } from '../../../shared/domain/operation-type.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { AuditWriter } from '../../audit/application/audit-writer';
import { FailureCode } from '../../audit/persistence/failure-record.entity';
import { Operation } from '../../operation/persistence/operation.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { describeRpcError, summarizeRpcError } from '../../transaction/rpc/rpc-error';
import { encodeAuthorizedTransfer, type OwnerConsentPurpose } from '../../transaction/signing/owner-consent';
import type { TransactionSubmissionPort } from '../../transaction/submission/transaction-submission.port';
import { isStoredExternalConsent, unsealExternalSignature } from './stored-consent';

const BATCH_SIZE = 20;

/**
 * Shared worker body for the two externally-signed flows (Reentry, External Resale): resubmits the
 * `OwnerConsent` the external wallet signed at accept time, unchanged (any different nonce/deadline
 * would no longer match that signature).
 *
 * 검증 D2: never marks an Operation ONCHAIN_CONFIRMED without its own transaction.
 * 검증 D3: a deterministic reject at submit (estimateGas revert) → REVIEW_REQUIRED **with** a
 * `reviewReason` and a `SUBMISSION_REJECTED` failure record carrying the redacted cause.
 * 검증 D8: the signature ciphertext is purged from `Operation.metadata` once the SIGNED attempt
 * exists (the encrypted raw transaction is then the only copy).
 */
export abstract class ExternalConsentWorkerBase extends IntervalWorker {
  protected abstract readonly logger: Logger;
  protected abstract readonly operationType: OperationType;
  protected abstract readonly consentPurpose: OwnerConsentPurpose;
  protected abstract readonly submittedReason: string;
  protected abstract readonly label: string;

  protected constructor(
    protected readonly dataSource: DataSource,
    protected readonly operationRepository: OperationRepository,
    protected readonly assetLockRepository: AssetLockRepository,
    protected readonly cubeNftReader: CubeNftReaderService,
    protected readonly submission: TransactionSubmissionPort,
    protected readonly appConfig: AppConfigService,
    protected readonly auditWriter: AuditWriter,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.submission.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const operations = await this.dataSource.getRepository(Operation).find({
      where: { type: this.operationType, status: OperationStatus.REQUESTED },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    for (const operation of operations) {
      try {
        await this.process(operation);
      } catch (error) {
        this.logger.warn(
          `${this.label} processing failed for operation ${operation.id}: ${describeRpcError(error)}`,
        );
      }
    }
  }

  private async process(operation: Operation): Promise<void> {
    if (!operation.fromAddress || !operation.toAddress) {
      // Unprocessable row — park it rather than throwing every tick and starving the batch.
      await this.reject(operation, 'INVALID_OPERATION_DATA', 'operation is missing from/to');
      return;
    }
    if (!isStoredExternalConsent(operation.metadata)) {
      await this.reject(
        operation,
        'INVALID_OPERATION_DATA',
        'operation is missing its stored consent metadata',
      );
      return;
    }
    if (!operation.metadata.externalSignatureCiphertext) {
      // Ciphertext is purged only after a SIGNED attempt exists, so a REQUESTED Operation without
      // it can never be submitted again — surface it instead of looping.
      await this.reject(
        operation,
        'CONSENT_SIGNATURE_UNAVAILABLE',
        'stored external signature was already purged',
      );
      return;
    }
    const expectedFrom = getAddress(operation.fromAddress);
    const expectedTo = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);
    if (!actualOwner || getAddress(actualOwner) !== expectedFrom) {
      await this.flagOwnerConflict(operation, actualOwner, expectedTo);
      return;
    }

    const consent = {
      tokenId: operation.tokenId,
      currentOwner: expectedFrom,
      from: expectedFrom,
      to: expectedTo,
      purpose: this.consentPurpose,
      nonce: BigInt(operation.metadata.consentNonce),
      deadline: BigInt(operation.metadata.consentDeadline),
    };

    if (consent.deadline <= BigInt(Math.floor(Date.now() / 1000))) {
      await this.reject(operation, 'CONSENT_EXPIRED', 'the signed consent deadline passed before submission');
      return;
    }

    const externalSignature = unsealExternalSignature(
      this.appConfig.submission.rawTxEncryptionKey,
      operation.metadata.externalSignatureCiphertext,
    );
    const data = encodeAuthorizedTransfer(consent, externalSignature);

    try {
      await this.submission.submit({
        operationId: operation.id,
        chainId: this.appConfig.cubeNft.deployment.chainId,
        signerRole: 'relayer',
        to: this.appConfig.cubeNft.deployment.proxyAddress,
        data,
      });
    } catch (error) {
      // A stale nonce/deadline or an invalid signature fails deterministically at estimateGas —
      // retrying with the same stored consent will never succeed; a human (or a fresh
      // challenge+signature via the operator recovery path) is needed, not another automatic try.
      const summary = summarizeRpcError(error);
      await this.reject(
        operation,
        'CONSENT_REJECTED_ON_SUBMIT',
        `${summary.class}/${summary.code}: ${summary.reason}`,
      );
      return;
    }

    await this.purgeStoredSignature(operation);
    await this.transitionQuietly(operation.id, OperationStatus.SUBMITTED, this.submittedReason);
  }

  private async purgeStoredSignature(operation: Operation): Promise<void> {
    const purged = { ...(operation.metadata ?? {}), externalSignatureCiphertext: null };
    await this.dataSource
      .createQueryBuilder()
      .update(Operation)
      .set({ metadata: purged } as unknown as QueryDeepPartialEntity<Operation>)
      .where('id = :id', { id: operation.id })
      .execute();
  }

  private async reject(operation: Operation, reason: string, cause: string): Promise<void> {
    await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, reason);
    await this.auditWriter
      .writeFailure({
        code: FailureCode.SUBMISSION_REJECTED,
        operationId: operation.id,
        details: {
          reason,
          cause,
          tokenId: operation.tokenId,
          from: operation.fromAddress,
          to: operation.toAddress,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `Failure-record write failed for operation ${operation.id}: ${(error as Error).message}`,
        );
      });
    this.logger.warn(
      `${this.label} operation ${operation.id} moved to REVIEW_REQUIRED (${reason}): ${cause}`,
    );
  }

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
