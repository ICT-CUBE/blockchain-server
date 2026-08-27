import { AuditRecord } from '../../domains/audit/persistence/audit-record.entity';
import { FailureRecord } from '../../domains/audit/persistence/failure-record.entity';
import { MetadataDependency } from '../../domains/metadata/persistence/metadata-dependency.entity';
import { HmacNonce } from '../auth/hmac/hmac-nonce.entity';
import { NotificationDelivery } from '../../domains/notification/persistence/notification-delivery.entity';
import { OperationStateHistory } from '../../domains/operation/persistence/operation-state-history.entity';
import { Operation } from '../../domains/operation/persistence/operation.entity';
import { ApprovalJtiBinding } from '../../domains/transaction/persistence/approval-jti-binding.entity';
import { AssetLock } from '../../domains/transaction/persistence/asset-lock.entity';
import { SignerNonceReservation } from '../../domains/transaction/persistence/signer-nonce-reservation.entity';
import { TransactionAttempt } from '../../domains/transaction/persistence/transaction-attempt.entity';
import { WalletAccount } from '../../domains/wallet/persistence/wallet-account.entity';

/** Single source of truth for every entity in the schema — used by both the NestJS
 * `DatabaseModule` and the standalone `data-source.ts` the TypeORM CLI uses for migrations, so the
 * two can never drift apart. */
export const ALL_ENTITIES = [
  WalletAccount,
  Operation,
  OperationStateHistory,
  TransactionAttempt,
  AssetLock,
  SignerNonceReservation,
  ApprovalJtiBinding,
  NotificationDelivery,
  FailureRecord,
  AuditRecord,
  MetadataDependency,
  HmacNonce,
];
