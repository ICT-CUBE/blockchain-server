import { z } from 'zod';

import { AuditCategory } from '../persistence/audit-record.entity';
import { FailureCode } from '../persistence/failure-record.entity';

const pageSchema = z.coerce.number().int().min(1).default(1);
const pageSizeSchema = z.coerce.number().int().min(1).max(100).default(20);

export const listFailuresQuerySchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  code: z.enum(FailureCode).optional(),
  operationId: z.string().uuid().optional(),
  /** "true"/"false" as query-string text; omit to return both resolved and unresolved. */
  resolved: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});
export type ListFailuresQuery = z.infer<typeof listFailuresQuerySchema>;

export const resolveFailureBodySchema = z.object({
  resolution: z.string().min(1).max(255),
});
export type ResolveFailureBody = z.infer<typeof resolveFailureBodySchema>;

export const listAuditRecordsQuerySchema = z.object({
  page: pageSchema,
  pageSize: pageSizeSchema,
  category: z.enum(AuditCategory).optional(),
  operationId: z.string().uuid().optional(),
});
export type ListAuditRecordsQuery = z.infer<typeof listAuditRecordsQuerySchema>;
