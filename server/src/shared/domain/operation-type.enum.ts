/** Common Operation type, shared by every domain that creates an Operation
 * (TASK-04 §4 공통 변경 사항). */
export enum OperationType {
  MINT = 'MINT',
  TRANSFER = 'TRANSFER',
  WITHDRAWAL = 'WITHDRAWAL',
  REENTRY = 'REENTRY',
  EXTERNAL_RESALE = 'EXTERNAL_RESALE',
}
