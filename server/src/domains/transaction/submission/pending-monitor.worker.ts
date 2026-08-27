import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'ethers';
import { DataSource, LessThan } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { decryptRawTransaction } from '../encryption/raw-transaction-cipher';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { RpcService } from '../rpc/rpc.service';
import { SystemSignerService } from '../signing/system-signer.service';
import { TransactionSubmissionService } from './transaction-submission.service';

/**
 * The 5-minute RBF loop (TASK-10 §5): finds BROADCAST attempts that have sat unconfirmed past
 * `rbfThresholdMs`, and fee-bumps them with a new attempt at the same nonce. Only ever acts on an
 * operation's *latest* attempt — an operation with an in-flight replacement already has a newer
 * attempt to judge staleness by. Gives up (REVIEW_REQUIRED) once `rbfMaxAttempts` is reached rather
 * than bumping fees without bound (TASK-10 §12 "gas 무한 상승" risk).
 */
@Injectable()
export class PendingMonitorWorker extends IntervalWorker {
  protected readonly logger = new Logger(PendingMonitorWorker.name);
  private static readonly BATCH_SIZE = 20;

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: RpcService,
    private readonly submission: TransactionSubmissionService,
    private readonly systemSigner: SystemSignerService,
    private readonly operationRepository: OperationRepository,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.submission.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const { rbfThresholdMs } = this.appConfig.submission;
    const staleBefore = new Date(Date.now() - rbfThresholdMs);

    const candidates = await this.dataSource.getRepository(TransactionAttempt).find({
      where: { status: TransactionAttemptStatus.BROADCAST, broadcastAt: LessThan(staleBefore) },
      order: { broadcastAt: 'ASC' },
      take: PendingMonitorWorker.BATCH_SIZE,
    });

    for (const attempt of candidates) {
      try {
        await this.evaluate(attempt);
      } catch (error) {
        this.logger.warn(
          `Pending-monitor pass failed for attempt ${attempt.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async evaluate(attempt: TransactionAttempt): Promise<void> {
    const isLatest = await this.isLatestAttempt(attempt);
    if (!isLatest) {
      return;
    }

    const operation = await this.operationRepository.findById(attempt.operationId);
    if (
      !operation ||
      (operation.status !== OperationStatus.SUBMITTED && operation.status !== OperationStatus.PENDING)
    ) {
      return;
    }

    // A receipt may already exist even though we haven't run confirmation evaluation yet — don't
    // fee-bump a transaction that is, in fact, already mined.
    const receipt = await this.rpc.getTransactionReceipt(attempt.txHash);
    if (receipt) {
      return;
    }

    const attemptCount = await this.dataSource
      .getRepository(TransactionAttempt)
      .count({ where: { operationId: attempt.operationId } });
    if (attemptCount >= this.appConfig.submission.rbfMaxAttempts) {
      await this.giveUp(operation.id, operation.status);
      return;
    }

    await this.replaceWithHigherFee(attempt);
  }

  private async isLatestAttempt(attempt: TransactionAttempt): Promise<boolean> {
    const latest = await this.dataSource.getRepository(TransactionAttempt).findOne({
      where: { operationId: attempt.operationId },
      order: { attemptNo: 'DESC' },
    });
    return latest?.id === attempt.id;
  }

  private async giveUp(operationId: string, expectedStatus: OperationStatus): Promise<void> {
    try {
      await this.operationRepository.transition(
        operationId,
        expectedStatus,
        OperationStatus.REVIEW_REQUIRED,
        'RBF_LIMIT_EXCEEDED',
      );
    } catch {
      // Already moved by a concurrent finalizer (e.g. confirmation found a receipt in the
      // meantime) — nothing to do.
    }
  }

  private async replaceWithHigherFee(previous: TransactionAttempt): Promise<void> {
    const rawTransaction = decryptRawTransaction(
      this.appConfig.submission.rawTxEncryptionKey,
      previous.rawTransactionCiphertext,
    );
    const parsed = Transaction.from(rawTransaction);
    if (!parsed.to) {
      throw new Error(`Attempt ${previous.id}'s stored raw transaction has no "to" — cannot rebuild for RBF`);
    }

    const bumpMultiplier = 1 + this.appConfig.submission.rbfFeeBumpPercent / 100;
    const bumpedMaxFee = this.bump(BigInt(previous.maxFeePerGasWei ?? '0'), bumpMultiplier);
    const bumpedPriorityFee = this.bump(BigInt(previous.maxPriorityFeePerGasWei ?? '0'), bumpMultiplier);

    const networkFee = await this.rpc.getFeeData();
    const maxFeePerGas = networkFee.maxFeePerGas > bumpedMaxFee ? networkFee.maxFeePerGas : bumpedMaxFee;
    const maxPriorityFeePerGas =
      networkFee.maxPriorityFeePerGas > bumpedPriorityFee
        ? networkFee.maxPriorityFeePerGas
        : bumpedPriorityFee;

    const role = this.systemSigner.roleForAddress(previous.signerAddress);

    await this.submission.submitReplacement({
      operationId: previous.operationId,
      chainId: previous.chainId,
      signerRole: role,
      to: parsed.to,
      data: parsed.data,
      value: parsed.value,
      nonce: previous.transactionNonce,
      maxFeePerGas,
      maxPriorityFeePerGas,
      replacesAttemptId: previous.id,
    });

    this.logger.log(
      `RBF: replaced attempt ${previous.id} (operation ${previous.operationId}, nonce ${previous.transactionNonce}) with a higher-fee attempt`,
    );
  }

  private bump(value: bigint, multiplier: number): bigint {
    // Integer-only bump: multiply by (1000 + percent*10) / 1000 to avoid floating point on wei
    // amounts, matching `multiplier` to two decimal places of precision (enough for a percent bump).
    const scaled = Math.round(multiplier * 1000);
    return (value * BigInt(scaled)) / 1000n;
  }
}
