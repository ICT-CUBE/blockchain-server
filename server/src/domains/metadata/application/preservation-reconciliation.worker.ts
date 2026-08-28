import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { MetadataService } from './metadata.service';

/**
 * 검증 피드백: preservation recovery must not depend on the Backend calling `prepare()` again. This
 * poller drives `MetadataService.reconcilePreservationBatch()` — refreshing `PENDING` pins via
 * `checkStatus`, and re-claiming stale `SUBMITTING` rows (submitter presumed crashed) with a fresh
 * claim token so they get resubmitted. Plain interval, same pattern as TASK-10/11's workers.
 */
@Injectable()
export class PreservationReconciliationWorker extends IntervalWorker {
  protected readonly logger = new Logger(PreservationReconciliationWorker.name);

  constructor(
    private readonly metadataService: MetadataService,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.metadata.preservationPollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    await this.metadataService.reconcilePreservationBatch();
  }
}
