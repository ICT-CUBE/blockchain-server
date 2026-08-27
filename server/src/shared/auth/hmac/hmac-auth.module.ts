import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '../../config/config.module';
import { HmacNonce } from './hmac-nonce.entity';
import { HmacNonceRepository } from './hmac-nonce.repository';
import { HmacGuard } from './hmac.guard';
import { OperatorHmacGuard } from './operator-hmac.guard';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([HmacNonce])],
  providers: [HmacNonceRepository, HmacGuard, OperatorHmacGuard],
  exports: [HmacNonceRepository, HmacGuard, OperatorHmacGuard],
})
export class HmacAuthModule {}
