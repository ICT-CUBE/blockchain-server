import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { decryptRawTransaction } from '../encryption/raw-transaction-cipher';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { TransactionSubmissionService } from './transaction-submission.service';

/** Re-broadcasts attempts stuck at SIGNED — the state a crash between "raw tx committed" and
 * "broadcast succeeded" leaves behind (TASK-10 §5: "제출 전 중단은 저장 raw transaction으로 동일
 * txHash를 제출"). Rebroadcasting an already-broadcast transaction is a harmless no-op
 * (`RpcService.broadcastTransaction` treats "already known" as success), so this can run on every
 * tick without tracking which attempts it already retried. */
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
    const stuck = await this.dataSource.getRepository(TransactionAttempt).find({
      where: { status: TransactionAttemptStatus.SIGNED },
      order: { createdAt: 'ASC' },
      take: SignedAttemptRecoveryWorker.BATCH_SIZE,
    });

    for (const attempt of stuck) {
      try {
        const rawTransaction = decryptRawTransaction(
          this.appConfig.submission.rawTxEncryptionKey,
          attempt.rawTransactionCiphertext,
        );
        await this.submission.rebroadcast(attempt.id, rawTransaction);
      } catch (error) {
        this.logger.warn(
          `Recovery re-broadcast failed for attempt ${attempt.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}
