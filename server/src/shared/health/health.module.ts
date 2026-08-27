import { Module } from '@nestjs/common';

import { WalletModule } from '../../domains/wallet/wallet.module';
import { ConfigModule } from '../config/config.module';
import { HealthController } from './health.controller';

@Module({
  imports: [ConfigModule, WalletModule],
  controllers: [HealthController],
})
export class HealthModule {}
