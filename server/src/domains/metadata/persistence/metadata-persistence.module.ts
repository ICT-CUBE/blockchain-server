import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MetadataDependency } from './metadata-dependency.entity';

@Module({
  imports: [TypeOrmModule.forFeature([MetadataDependency])],
  exports: [TypeOrmModule],
})
export class MetadataPersistenceModule {}
