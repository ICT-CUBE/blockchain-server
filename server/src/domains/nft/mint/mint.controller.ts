import { Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';

import type { MintApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
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
import { MintApplication } from './mint.application';
import { mintRequestBodySchema, type MintRequestBody } from './mint-request.schema';

/**
 * `POST /internal/v1/mints` — TASK-06's guard chain (HMAC -> ApprovalJwtGuard(MINT)) around
 * TASK-07's `MintApplication.accept()`, which resolves the user's custodial wallet, cross-checks
 * it against the approval token, and atomically creates the Operation + asset lock + jti binding.
 */
@Controller('internal/v1/mints')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class MintController {
  private readonly logger = new Logger(MintController.name);

  constructor(
    private readonly mintApplication: MintApplication,
    private readonly auditWriter: AuditWriter,
  ) {}

  @Post()
  @RequiresApproval(OperationType.MINT)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(mintRequestBodySchema)) body: MintRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    // Safe: ApprovalJwtGuard already rejected any token whose `purpose` isn't MINT for this route.
    const approval = request.approval as MintApprovalClaims;

    const { operation } = await this.mintApplication.accept(body, approval);

    // TASK-14 §9: isolated from the accept transaction on purpose — the Operation is already
    // durably created by this point, and a supplementary audit-trail write must never turn a
    // successful accept into a failed response. Logged, not rethrown, on failure.
    this.auditWriter
      .writeAudit({
        category: AuditCategory.BUSINESS_EVENT,
        actor: approval.userId,
        action: 'MINT_ACCEPTED',
        target: String(operation.tokenId),
        requestId: request.requestId,
        operationId: operation.id,
        details: { cubeId: approval.cubeId },
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
