export interface PageResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface FailureRecordResponse {
  id: string;
  code: string;
  operationId: string | null;
  attemptId: string | null;
  notificationId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: string;
  resolvedAt: string | null;
  resolution: string | null;
}

export interface AuditRecordResponse {
  id: string;
  category: string;
  actor: string;
  action: string;
  target: string | null;
  requestId: string | null;
  operationId: string | null;
  details: Record<string, unknown> | null;
  occurredAt: string;
}
