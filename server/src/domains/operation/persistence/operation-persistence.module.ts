import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { OperationStateHistory } from './operation-state-history.entity';
import { Operation } from './operation.entity';
import { OperationRepository } from './operation.repository';

@Module({
  imports: [TypeOrmModule.forFeature([Operation, OperationStateHistory])],
  providers: [OperationRepository],
  exports: [OperationRepository, TypeOrmModule],
})
export class OperationPersistenceModule {}
