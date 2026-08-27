import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { OperationFinalizer } from '../../operation/finalizer/operation-finalizer.service';
import { Operation } from '../../operation/persistence/operation.entity';
import { ConfirmationService } from './confirmation.service';

/**
 * TASK-11 §5's reconciliation scheduler: batches every Operation still waiting on-chain
 * (SUBMITTED/PENDING/UNKNOWN — not ONCHAIN_CONFIRMED, that's TASK-12's notification worker's
 * concern, and not REVIEW_REQUIRED, which stays for manual resolution per §9 "자동 DB 소유권 복구도
 * 하지 않는다") and re-evaluates each one. Also what makes the system self-healing across a restart:
 * every in-flight Operation is picked back up from DB state alone, nothing in-memory is required.
 */
@Injectable()
export class ReconciliationScheduler extends IntervalWorker {
  protected readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly confirmationService: ConfirmationService,
    private readonly finalizer: OperationFinalizer,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.confirmation.reconciliationPollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const candidates = await this.dataSource.getRepository(Operation).find({
      where: [
        { status: OperationStatus.SUBMITTED },
        { status: OperationStatus.PENDING },
        { status: OperationStatus.UNKNOWN },
      ],
      order: { updatedAt: 'ASC' },
      take: this.appConfig.confirmation.reconciliationBatchSize,
    });

    for (const operation of candidates) {
      try {
        const result = await this.confirmationService.evaluate(operation);
        await this.finalizer.apply(operation, result);
      } catch (error) {
        this.logger.warn(
          `Reconciliation pass failed for operation ${operation.id}: ${(error as Error).message}`,
        );
      }
    }
  }
}
