import { Injectable, Logger } from '@nestjs/common';
import { DataSource, IsNull, LessThanOrEqual } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { decryptRawTransaction } from '../encryption/raw-transaction-cipher';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { TransactionSubmissionService } from './transaction-submission.service';

/** Re-broadcasts attempts stuck at SIGNED — the state a crash between "raw tx committed" and
 * "broadcast succeeded" (or any failed broadcast) leaves behind (TASK-10 §5: "제출 전 중단은 저장
 * raw transaction으로 동일 txHash를 제출"). Rebroadcasting an already-broadcast transaction is a
 * harmless no-op (`RpcService.broadcastTransaction` treats "already known" as success).
 *
 * 검증 D1: not every tick and not forever any more — only attempts whose `nextBroadcastAt` backoff
 * has elapsed are picked up, **lowest nonce first per signer** so the attempt that would close a
 * nonce gap is always tried before the ones queued behind it. Retry budget, escalation to
 * REVIEW_REQUIRED and redacted error recording all live in `TransactionSubmissionService.rebroadcast`. */
@Injectable()
export class SignedAttemptRecoveryWorker extends IntervalWorker {
  protected readonly logger = new Logger(SignedAttemptRecoveryWorker.name);
  private static readonly BATCH_SIZE = 20;

  constructor(
    private readonly dataSource: DataSource,
    private readonly submission: TransactionSubmissionService,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.submission.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const now = new Date();
    const due = await this.dataSource.getRepository(TransactionAttempt).find({
      where: [
        { status: TransactionAttemptStatus.SIGNED, nextBroadcastAt: IsNull() },
        { status: TransactionAttemptStatus.SIGNED, nextBroadcastAt: LessThanOrEqual(now) },
      ],
      order: { signerAddress: 'ASC', transactionNonce: 'ASC', createdAt: 'ASC' },
      take: SignedAttemptRecoveryWorker.BATCH_SIZE,
    });

    for (const attempt of due) {
      if (!attempt.rawTransactionCiphertext) {
        // Purged ciphertext on a SIGNED attempt should be impossible (purge only happens after
        // final confirmation); log once per tick rather than loop on it.
        this.logger.error(
          `Attempt ${attempt.id} is SIGNED but its raw transaction was purged — cannot recover`,
        );
        continue;
      }
      try {
        const rawTransaction = decryptRawTransaction(
          this.appConfig.submission.rawTxEncryptionKey,
          attempt.rawTransactionCiphertext,
        );
        const outcome = await this.submission.rebroadcast(attempt, rawTransaction);
        if (outcome.status === 'BROADCAST') {
          this.logger.log(
            `Recovered attempt ${attempt.id} (nonce ${attempt.transactionNonce}) — broadcast succeeded on try ${attempt.broadcastAttemptCount + 1}`,
          );
        }
      } catch (error) {
        // Only non-RPC failures reach here (decrypt/DB); RPC outcomes are handled inside rebroadcast.
        this.logger.warn(`Recovery pass failed for attempt ${attempt.id}: ${(error as Error).message}`);
      }
    }
  }
}
