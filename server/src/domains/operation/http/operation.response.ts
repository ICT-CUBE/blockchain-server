import type { OperationStatus } from '../../../shared/domain/operation-status.enum';
import type { OperationType } from '../../../shared/domain/operation-type.enum';

export interface OperationResponse {
  operationId: string;
  type: OperationType;
  status: OperationStatus;
  tokenId: number;
  fromAddress: string | null;
  toAddress: string | null;
  reviewReason: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}
