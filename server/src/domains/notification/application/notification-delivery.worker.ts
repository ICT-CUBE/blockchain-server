import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { IntervalWorker } from '../../../shared/scheduling/interval-worker';
import { NotificationOutboxRepository } from '../persistence/notification-outbox.repository';
import { NotificationDeliveryService } from './notification-delivery.service';

/** TASK-12's delivery loop: claims a batch of due (PENDING/RETRYING, not currently locked) outbox
 * rows and attempts each — `NotificationOutboxRepository.claimDueBatch`'s lock/claim-token dance is
 * what already makes this safe if more than one process ever runs this worker concurrently. */
@Injectable()
export class NotificationDeliveryWorker extends IntervalWorker {
  protected readonly logger = new Logger(NotificationDeliveryWorker.name);

  constructor(
    private readonly outbox: NotificationOutboxRepository,
    private readonly deliveryService: NotificationDeliveryService,
    private readonly appConfig: AppConfigService,
  ) {
    super();
  }

  protected intervalMs(): number {
    return this.appConfig.notification.pollIntervalMs;
  }

  protected async runOnce(): Promise<void> {
    const batch = await this.outbox.claimDueBatch(this.appConfig.notification.batchSize);
    for (const delivery of batch) {
      try {
        await this.deliveryService.attemptDelivery(delivery);
      } catch (error) {
        this.logger.warn(
          `Delivery attempt failed unexpectedly for ${delivery.notificationId}: ${(error as Error).message}`,
        );
      }
    }
  }
}
