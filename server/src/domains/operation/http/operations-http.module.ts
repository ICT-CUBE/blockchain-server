import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { TransactionPersistenceModule } from '../../transaction/persistence/transaction-persistence.module';
import { OperationPersistenceModule } from '../persistence/operation-persistence.module';
import { OperationsController } from './operations.controller';

@Module({
  imports: [HmacAuthModule, OperationPersistenceModule, TransactionPersistenceModule],
  controllers: [OperationsController],
})
export class OperationsHttpModule {}
