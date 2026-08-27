import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ConfigModule } from '../../config/config.module';
import { HmacNonce } from './hmac-nonce.entity';
import { HmacNonceRepository } from './hmac-nonce.repository';
import { HmacGuard } from './hmac.guard';

@Module({
  imports: [ConfigModule, TypeOrmModule.forFeature([HmacNonce])],
  providers: [HmacNonceRepository, HmacGuard],
  exports: [HmacNonceRepository, HmacGuard],
})
export class HmacAuthModule {}
