import type { OperationStatus } from '../domain/operation-status.enum';
import type { OperationType } from '../domain/operation-type.enum';

/** The one shape every 202-accepted mutation endpoint returns — no txHash yet, per TASK-06 §6:
 * "접수 응답은 txHash 없이 REQUESTED를 반환할 수 있다." */
export interface OperationAcceptedResponse {
  operationId: string;
  status: OperationStatus;
  type: OperationType;
  tokenId: number;
}
