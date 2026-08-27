import { Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';

import type { ReentryApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import {
  ApprovalJwtGuard,
  type RequestWithApproval,
} from '../../../shared/auth/approval-jwt/approval-jwt.guard';
import { RequiresApproval } from '../../../shared/auth/approval-jwt/requires-approval.decorator';
import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import type { OperationAcceptedResponse } from '../../../shared/http/operation-accepted.response';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { AuditWriter } from '../../audit/application/audit-writer';
import { AuditCategory } from '../../audit/persistence/audit-record.entity';
import { ReentryApplication } from './reentry.application';
import { reentryRequestBodySchema, type ReentryRequestBody } from './reentry-request.schema';

/** `POST /internal/v1/reentries` — TASK-09's Reentry accept endpoint. */
@Controller('internal/v1/reentries')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class ReentryController {
  private readonly logger = new Logger(ReentryController.name);

  constructor(
    private readonly reentryApplication: ReentryApplication,
    private readonly auditWriter: AuditWriter,
  ) {}

  @Post()
  @RequiresApproval(OperationType.REENTRY)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(reentryRequestBodySchema)) body: ReentryRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as ReentryApprovalClaims;

    const { operation } = await this.reentryApplication.accept(body, approval);

    // TASK-14 §9: isolated from the accept transaction — see MintController for the rationale.
    this.auditWriter
      .writeAudit({
        category: AuditCategory.BUSINESS_EVENT,
        actor: approval.userId,
        action: 'REENTRY_ACCEPTED',
        target: String(operation.tokenId),
        requestId: request.requestId,
        operationId: operation.id,
      })
      .catch((error: unknown) => {
        this.logger.warn(`Audit write failed for operation ${operation.id}: ${(error as Error).message}`);
      });

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
