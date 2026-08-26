import { Module } from '@nestjs/common';

import { ConfigModule } from './shared/config/config.module';
import { HealthModule } from './shared/health/health.module';

@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
