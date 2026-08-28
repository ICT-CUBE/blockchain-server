import type { OperationStatus } from '../../../shared/domain/operation-status.enum';
import type { OperationType } from '../../../shared/domain/operation-type.enum';
import type { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';

/** One row of `txAttempts` — every attempt ever made for the Operation (original + RBF
 * replacements), so a consumer can verify each txHash independently (AC-021). */
export interface TxAttemptResponse {
  attemptId: string;
  attemptNo: number;
  txHash: string;
  nonce: string;
  status: TransactionAttemptStatus;
  receiptBlockNumber: string | null;
  receiptBlockHash: string | null;
  receiptStatus: number | null;
  confirmations: number | null;
  broadcastAttemptCount: number;
  lastBroadcastError: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
}

export interface NotificationStateResponse {
  notificationId: string;
  status: string;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  lastError: string | null;
}

/** `GET /internal/v1/operations/:id` — `docs/openapi.yaml#/components/schemas/OperationView`.
 * Works independently of webhook delivery (TASK-12 §5) and carries the confirmation evidence and
 * notification state the plan requires (검증 D7, §4 계약). */
export interface OperationResponse {
  operationId: string;
  idempotencyKey: string;
  type: OperationType;
  status: OperationStatus;
  tokenId: number;
  fromAddress: string | null;
  toAddress: string | null;
  reviewReason: string | null;
  failureCode: string | null;
  /** Confirmed attempt's txHash when confirmed, else the latest attempt's, else null. */
  currentTxHash: string | null;
  confirmations: number;
  finalOwnerAddress: string | null;
  serviceRightsState: 'EXTERNAL_INACTIVE' | 'ELIGIBLE_FOR_ACTIVATION' | null;
  txAttempts: TxAttemptResponse[];
  notification: NotificationStateResponse | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  onchainConfirmedAt: string | null;
  completedAt: string | null;
}
