import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

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
 * REVIEW_REQUIRED and redacted error recording all live in `TransactionSubmissionService.rebroadcast`.
 *
 * 검증 문제 1: the "is the backoff up?" comparison uses the DB's own clock (`NOW(3)`), never the
 * worker process's `new Date()` — `nextBroadcastAt` is written with `DATE_ADD(NOW(3), …)`, so both
 * sides of the comparison come from one clock and a KST-hosted (or multi-process) deployment can no
 * longer leave an attempt permanently un-recovered, which would keep the signer `NONCE_GAP`-halted. */
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
    const due = await this.dataSource
      .getRepository(TransactionAttempt)
      .createQueryBuilder('attempt')
      .where('attempt.status = :signed', { signed: TransactionAttemptStatus.SIGNED })
      .andWhere('(attempt.next_broadcast_at IS NULL OR attempt.next_broadcast_at <= NOW(3))')
      .orderBy('attempt.signer_address', 'ASC')
      .addOrderBy('attempt.transaction_nonce', 'ASC')
      .addOrderBy('attempt.created_at', 'ASC')
      .take(SignedAttemptRecoveryWorker.BATCH_SIZE)
      .getMany();

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
