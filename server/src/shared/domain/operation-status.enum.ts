/** Common Operation lifecycle status, shared by every domain that creates an Operation
 * (TASK-04 §4 공통 변경 사항). See docs `수행 계획서 - 세부 구현 계획.md` "공통 Operation 완료 의미"
 * for what ONCHAIN_CONFIRMED vs COMPLETED mean. */
export enum OperationStatus {
  REQUESTED = 'REQUESTED',
  SUBMITTED = 'SUBMITTED',
  PENDING = 'PENDING',
  ONCHAIN_CONFIRMED = 'ONCHAIN_CONFIRMED',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  UNKNOWN = 'UNKNOWN',
  REVIEW_REQUIRED = 'REVIEW_REQUIRED',
  CANCELLED = 'CANCELLED',
}
