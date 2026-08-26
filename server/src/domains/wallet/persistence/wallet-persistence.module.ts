import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { WalletAccount } from './wallet-account.entity';

@Module({
  imports: [TypeOrmModule.forFeature([WalletAccount])],
  exports: [TypeOrmModule],
})
export class WalletPersistenceModule {}
