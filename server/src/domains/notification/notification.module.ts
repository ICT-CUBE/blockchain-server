import { Module } from '@nestjs/common';

import { OperationPersistenceModule } from '../operation/persistence/operation-persistence.module';
import { NotificationDeliveryService } from './application/notification-delivery.service';
import { NotificationDeliveryWorker } from './application/notification-delivery.worker';
import { NotificationPersistenceModule } from './persistence/notification-persistence.module';

/** TASK-12: the delivery half of the notification outbox (`OperationFinalizer`, in the operation
 * domain, is what writes rows into it). Exports `NotificationDeliveryService` so the redeliver
 * CLI script (`scripts/redeliver-notification.ts`) can reuse the exact same delivery/outcome logic
 * the background worker uses, rather than duplicating it. */
@Module({
  imports: [NotificationPersistenceModule, OperationPersistenceModule],
  providers: [NotificationDeliveryService, NotificationDeliveryWorker],
  exports: [NotificationDeliveryService],
})
export class NotificationModule {}
