import { Module } from '@nestjs/common';

import { OperationPersistenceModule } from '../../domains/operation/persistence/operation-persistence.module';
import { TransactionPersistenceModule } from '../../domains/transaction/persistence/transaction-persistence.module';
import { OperationIntakeService } from './operation-intake.service';

@Module({
  imports: [OperationPersistenceModule, TransactionPersistenceModule],
  providers: [OperationIntakeService],
  exports: [OperationIntakeService],
})
export class OperationIntakeModule {}
