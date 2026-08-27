import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';

import { OperatorHmacGuard } from '../../../shared/auth/hmac/operator-hmac.guard';
import { ApiError } from '../../../shared/http/api-error';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { AuditRecord } from '../persistence/audit-record.entity';
import { FailureRecord } from '../persistence/failure-record.entity';
import {
  listAuditRecordsQuerySchema,
  listFailuresQuerySchema,
  resolveFailureBodySchema,
  type ListAuditRecordsQuery,
  type ListFailuresQuery,
  type ResolveFailureBody,
} from './audit-query.schema';
import type { AuditRecordResponse, FailureRecordResponse, PageResponse } from './audit.response';

function toFailureResponse(record: FailureRecord): FailureRecordResponse {
  return {
    id: record.id,
    code: record.code,
    operationId: record.operationId,
    attemptId: record.attemptId,
    notificationId: record.notificationId,
    details: record.details,
    occurredAt: record.occurredAt.toISOString(),
    resolvedAt: record.resolvedAt ? record.resolvedAt.toISOString() : null,
    resolution: record.resolution,
  };
}

function toAuditResponse(record: AuditRecord): AuditRecordResponse {
  return {
    id: record.id,
    category: record.category,
    actor: record.actor,
    action: record.action,
    target: record.target,
    requestId: record.requestId,
    operationId: record.operationId,
    details: record.details,
    occurredAt: record.occurredAt.toISOString(),
  };
}

/**
 * `GET /internal/v1/audit/failures`, `POST /internal/v1/audit/failures/:id/resolve`, and
 * `GET /internal/v1/audit/records` — TASK-14 §5's operator query surface, deliberately read-only
 * plus one narrow resolve action (never a generic admin UI or write API — §3 rules that out). Gated
 * by `OperatorHmacGuard`, a key scope entirely separate from the inbound key every other endpoint in
 * this service accepts, so read access to the audit trail can't be had with the same credential used
 * to create Operations.
 */
@Controller('internal/v1/audit')
@UseGuards(OperatorHmacGuard)
export class AuditController {
  constructor(
    @InjectRepository(FailureRecord) private readonly failureRepository: Repository<FailureRecord>,
    @InjectRepository(AuditRecord) private readonly auditRepository: Repository<AuditRecord>,
  ) {}

  @Get('failures')
  @HttpCode(200)
  async listFailures(
    @Query(new ZodValidationPipe(listFailuresQuerySchema)) query: ListFailuresQuery,
  ): Promise<PageResponse<FailureRecordResponse>> {
    const where: Record<string, unknown> = {};
    if (query.code) where.code = query.code;
    if (query.operationId) where.operationId = query.operationId;
    if (query.resolved === true) where.resolvedAt = Not(IsNull());
    if (query.resolved === false) where.resolvedAt = IsNull();

    const [items, total] = await this.failureRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });

    return {
      items: items.map(toFailureResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  @Post('failures/:id/resolve')
  @HttpCode(200)
  async resolveFailure(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body(new ZodValidationPipe(resolveFailureBodySchema)) body: ResolveFailureBody,
  ): Promise<FailureRecordResponse> {
    const record = await this.failureRepository.findOne({ where: { id } });
    if (!record) {
      throw new ApiError('FAILURE_RECORD_NOT_FOUND', `No failure record with id ${id}`, 404);
    }
    record.resolvedAt = new Date();
    record.resolution = body.resolution;
    const saved = await this.failureRepository.save(record);
    return toFailureResponse(saved);
  }

  @Get('records')
  @HttpCode(200)
  async listRecords(
    @Query(new ZodValidationPipe(listAuditRecordsQuerySchema)) query: ListAuditRecordsQuery,
  ): Promise<PageResponse<AuditRecordResponse>> {
    const where: Record<string, unknown> = {};
    if (query.category) where.category = query.category;
    if (query.operationId) where.operationId = query.operationId;

    const [items, total] = await this.auditRepository.findAndCount({
      where,
      order: { occurredAt: 'DESC' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    });

    return {
      items: items.map(toAuditResponse),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }
}
