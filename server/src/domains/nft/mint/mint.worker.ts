import { Inject, Injectable, Logger } from '@nestjs/common';
import { getAddress, Interface } from 'ethers';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { AuditWriter } from '../../audit/application/audit-writer';
import { FailureCode } from '../../audit/persistence/failure-record.entity';
import { MetadataService } from '../../metadata/application/metadata.service';
import { Operation } from '../../operation/persistence/operation.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import {
  TRANSACTION_SUBMISSION_PORT,
  type TransactionSubmissionPort,
} from '../../transaction/submission/transaction-submission.port';

const MINT_INTERFACE = new Interface([
  'function mintTo(address to, uint256 tokenId, string tokenUri) external',
]);
const BATCH_SIZE = 20;

/**
 * TASK-07 §5's worker half: polls REQUESTED Mint Operations and drives each one to either
 * ONCHAIN_CONFIRMED (idempotent — already correctly minted, no new transaction needed),
 * REVIEW_REQUIRED (owner changed to something unexpected since accept-time), or SUBMITTED (built
 * `mintTo` calldata and handed it to TASK-10). Single-process assumption, same as the other
 * `IntervalWorker`s here — no cross-worker claim/lock beyond the base class's own overlap guard,
 * since an Operation this worker successfully processes always leaves REQUESTED before the next
 * tick could see it again.
 */
@Injectable()
export class MintWorker extends IntervalWorker {
  protected readonly logger = new Logger(MintWorker.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
    private readonly cubeNftReader: CubeNftReaderService,
    private readonly metadataService: MetadataService,
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
      where: { type: OperationType.MINT, status: OperationStatus.REQUESTED },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    for (const operation of operations) {
      try {
        await this.process(operation);
      } catch (error) {
        this.logger.warn(`Mint processing failed for operation ${operation.id}: ${(error as Error).message}`);
      }
    }
  }

  private async process(operation: Operation): Promise<void> {
    if (!operation.toAddress) {
      // Unprocessable row (cannot be produced via the API) — park it for a human instead of throwing
      // on every tick, which would occupy the batch and starve valid Operations behind it.
      await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'INVALID_OPERATION_DATA');
      return;
    }
    const expectedOwner = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);

    // 검증 D2: an Operation without its own transaction is never marked ONCHAIN_CONFIRMED. A token
    // that is already minted by the time we get here — to the expected owner or anyone else — was
    // minted by something other than this Operation, which is an integrity question for a human.
    if (actualOwner) {
      await this.flagOwnerConflict(operation, actualOwner, getAddress(actualOwner) === expectedOwner);
      return;
    }

    // MintApplication.accept() already required metadata to be READY before this Operation could
    // exist, but re-check here too — the only source of truth for "what tokenUri to mint with" is
    // TASK-13's own tracking, never re-derived from a fixed pattern.
    const tokenUri = await this.metadataService.tokenUri(operation.tokenId);
    if (!tokenUri) {
      await this.transitionQuietly(
        operation.id,
        OperationStatus.REVIEW_REQUIRED,
        'METADATA_NOT_READY_AT_SUBMIT',
      );
      return;
    }
    const data = MINT_INTERFACE.encodeFunctionData('mintTo', [expectedOwner, operation.tokenId, tokenUri]);

    await this.submission.submit({
      operationId: operation.id,
      chainId: this.appConfig.cubeNft.deployment.chainId,
      signerRole: 'mint',
      to: this.appConfig.cubeNft.deployment.proxyAddress,
      data,
    });

    await this.transitionQuietly(operation.id, OperationStatus.SUBMITTED, 'MINT_SUBMITTED');
  }

  /** The token got minted between accept-time and now — a data-integrity concern, not something
   * to retry automatically and (TASK-07 §5 "이미 owner가 기대 지갑이면 새 Mint하지 않는다") never a
   * second mint; 검증 D2 also forbids reporting it as this Operation's success. */
  private async flagOwnerConflict(
    operation: Operation,
    actualOwner: string,
    alreadyAtDestination: boolean,
  ): Promise<void> {
    await this.transitionQuietly(
      operation.id,
      OperationStatus.REVIEW_REQUIRED,
      alreadyAtDestination ? 'OWNER_ALREADY_AT_DESTINATION' : 'OWNER_MISMATCH_AT_SUBMIT',
    );
    await this.auditWriter
      .writeFailure({
        code: FailureCode.OWNER_MISMATCH,
        operationId: operation.id,
        details: { expectedOwner: operation.toAddress, actualOwner, alreadyAtDestination },
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
      // Already moved by a concurrent pass (e.g. reconciliation reached it independently) —
      // nothing left to do.
    }
  }
}
