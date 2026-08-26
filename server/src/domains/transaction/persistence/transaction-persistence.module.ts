import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ApprovalJtiBinding } from './approval-jti-binding.entity';
import { ApprovalJtiBindingRepository } from './approval-jti-binding.repository';
import { AssetLock } from './asset-lock.entity';
import { AssetLockRepository } from './asset-lock.repository';
import { SignerNonceReservation } from './signer-nonce-reservation.entity';
import { SignerNonceReservationRepository } from './signer-nonce-reservation.repository';
import { TransactionAttempt } from './transaction-attempt.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TransactionAttempt, AssetLock, SignerNonceReservation, ApprovalJtiBinding]),
  ],
  providers: [AssetLockRepository, SignerNonceReservationRepository, ApprovalJtiBindingRepository],
  exports: [
    AssetLockRepository,
    SignerNonceReservationRepository,
    ApprovalJtiBindingRepository,
    TypeOrmModule,
  ],
})
export class TransactionPersistenceModule {}
