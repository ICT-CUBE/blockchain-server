import { Module } from '@nestjs/common';

import { ApprovalJwtAuthModule } from '../../../shared/auth/approval-jwt/approval-jwt-auth.module';
import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { OperationIntakeModule } from '../../../shared/idempotency/operation-intake.module';
import { MintController } from './mint.controller';

@Module({
  imports: [HmacAuthModule, ApprovalJwtAuthModule, OperationIntakeModule],
  controllers: [MintController],
})
export class MintModule {}
