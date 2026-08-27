import { Inject, Injectable, Logger } from '@nestjs/common';
import { getAddress, Interface } from 'ethers';
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
      throw new Error(`Mint operation ${operation.id} has no toAddress`);
    }
    const expectedOwner = getAddress(operation.toAddress);

    const actualOwner = await this.cubeNftReader.ownerOf(operation.tokenId);

    if (actualOwner && getAddress(actualOwner) === expectedOwner) {
      await this.finalizeAlreadyMinted(operation);
      return;
    }

    if (actualOwner && getAddress(actualOwner) !== expectedOwner) {
      await this.flagOwnerConflict(operation);
      return;
    }

    const tokenUri = `${this.appConfig.mint.metadataBaseUri}${operation.tokenId}.json`;
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

  /** Idempotent completion (TASK-07 §5: "이미 owner가 기대 지갑이면... 새 Mint하지 않는다") — no
   * transaction needed, the token was already correctly minted (e.g. a retried accept after a
   * prior successful mint whose Operation never reached this worker in time). */
  private async finalizeAlreadyMinted(operation: Operation): Promise<void> {
    await this.transitionQuietly(
      operation.id,
      OperationStatus.ONCHAIN_CONFIRMED,
      'ALREADY_MINTED_IDEMPOTENT',
    );
    await this.assetLockRepository.release(operation.tokenId);
  }

  /** The owner changed between accept-time and now to something other than what this Operation
   * expects — a data-integrity concern, not something to retry automatically. */
  private async flagOwnerConflict(operation: Operation): Promise<void> {
    await this.transitionQuietly(operation.id, OperationStatus.REVIEW_REQUIRED, 'OWNER_MISMATCH_AT_SUBMIT');
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
