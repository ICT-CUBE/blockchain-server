import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { OperationPersistenceModule } from '../persistence/operation-persistence.module';
import { OperationsController } from './operations.controller';

@Module({
  imports: [HmacAuthModule, OperationPersistenceModule],
  controllers: [OperationsController],
})
export class OperationsHttpModule {}
