import { Module } from '@nestjs/common';

import { ConfigModule } from '../../config/config.module';
import { ApprovalJwtGuard } from './approval-jwt.guard';

@Module({
  imports: [ConfigModule],
  providers: [ApprovalJwtGuard],
  exports: [ApprovalJwtGuard],
})
export class ApprovalJwtAuthModule {}
