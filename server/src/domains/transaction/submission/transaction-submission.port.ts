import type { SystemSignerRole } from '../signing/system-signer.service';

export const TRANSACTION_SUBMISSION_PORT = Symbol('TRANSACTION_SUBMISSION_PORT');

export interface SubmitTransactionRequest {
  operationId: string;
  chainId: number;
  signerRole: SystemSignerRole;
  to: string;
  data: string;
  /** Wei, defaults to 0 — every `CubeNFT` call this port is used for (`mintTo`,
   * `authorizedTransfer`) is non-payable. */
  value?: bigint;
}

export interface SubmitTransactionResult {
  attemptId: string;
  attemptNo: number;
  txHash: string;
}

/**
 * Everything Mint/Transfer/Withdrawal/Reentry/External-Resale workers know about getting a
 * transaction onto the chain (TASK-10 §7: "내부 TransactionSubmissionPort"). Callers never see
 * nonces, gas, or raw transactions — this port owns nonce reservation, signing, encryption-at-rest,
 * and broadcast, and records everything needed for crash recovery and RBF.
 */
export interface TransactionSubmissionPort {
  submit(request: SubmitTransactionRequest): Promise<SubmitTransactionResult>;
}
