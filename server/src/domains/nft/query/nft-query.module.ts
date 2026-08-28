import { Module } from '@nestjs/common';

import { HmacAuthModule } from '../../../shared/auth/hmac/hmac-auth.module';
import { RpcModule } from '../../transaction/rpc/rpc.module';
import { NftQueryController } from './nft-query.controller';

@Module({
  imports: [HmacAuthModule, RpcModule],
  controllers: [NftQueryController],
})
export class NftQueryModule {}
