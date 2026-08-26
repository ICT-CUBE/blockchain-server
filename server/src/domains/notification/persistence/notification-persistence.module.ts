import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { NotificationDelivery } from './notification-delivery.entity';
import { NotificationOutboxRepository } from './notification-outbox.repository';

@Module({
  imports: [TypeOrmModule.forFeature([NotificationDelivery])],
  providers: [NotificationOutboxRepository],
  exports: [NotificationOutboxRepository, TypeOrmModule],
})
export class NotificationPersistenceModule {}
