import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { RpcModule } from '../../transaction/rpc/rpc.module';
import { ExternalConsentChallengeController } from './external-consent-challenge.controller';

@Module({
  imports: [HmacAuthModule, RpcModule],
  controllers: [ExternalConsentChallengeController],
})
export class ExternalConsentChallengeModule {}
