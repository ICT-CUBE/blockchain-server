import { Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';

import type { ExternalResaleApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
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
import { ExternalResaleApplication } from './external-resale.application';
import {
  externalResaleRequestBodySchema,
  type ExternalResaleRequestBody,
} from './external-resale-request.schema';

/** `POST /internal/v1/external-resales` — TASK-09's External-Resale accept endpoint. */
@Controller('internal/v1/external-resales')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class ExternalResaleController {
  private readonly logger = new Logger(ExternalResaleController.name);

  constructor(
    private readonly externalResaleApplication: ExternalResaleApplication,
    private readonly auditWriter: AuditWriter,
  ) {}

  @Post()
  @RequiresApproval(OperationType.EXTERNAL_RESALE)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(externalResaleRequestBodySchema)) body: ExternalResaleRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as ExternalResaleApprovalClaims;

    const { operation } = await this.externalResaleApplication.accept(body, approval);

    // TASK-14 §9: isolated from the accept transaction — see MintController for the rationale.
    this.auditWriter
      .writeAudit({
        category: AuditCategory.BUSINESS_EVENT,
        actor: approval.buyerUserId,
        action: 'EXTERNAL_RESALE_ACCEPTED',
        target: String(operation.tokenId),
        requestId: request.requestId,
        operationId: operation.id,
        details: { tradeId: approval.tradeId },
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
