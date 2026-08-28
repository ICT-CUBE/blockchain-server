import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { NotificationPersistenceModule } from '../../notification/persistence/notification-persistence.module';
import { TransactionPersistenceModule } from '../../transaction/persistence/transaction-persistence.module';
import { OperationPersistenceModule } from '../persistence/operation-persistence.module';
import { OperationsController } from './operations.controller';

@Module({
  imports: [
    HmacAuthModule,
    OperationPersistenceModule,
    TransactionPersistenceModule,
    NotificationPersistenceModule,
  ],
  controllers: [OperationsController],
})
export class OperationsHttpModule {}
