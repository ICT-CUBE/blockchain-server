/** Lifecycle of a single submitted transaction attempt, distinct from `OperationStatus` — one
 * Operation can accumulate many attempts (original + fee-bump replacements) before the Operation
 * itself reaches a terminal status (TASK-10/11). */
export enum TransactionAttemptStatus {
  /** Signed and its raw transaction committed to the DB, but not yet broadcast. */
  SIGNED = 'SIGNED',
  BROADCAST = 'BROADCAST',
  CONFIRMED = 'CONFIRMED',
  FAILED = 'FAILED',
  /** Superseded by a later fee-bump replacement attempt for the same (operationId, nonce). */
  SUPERSEDED = 'SUPERSEDED',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
}
