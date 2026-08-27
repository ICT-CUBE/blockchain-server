import { Body, Controller, HttpCode, Logger, Post, Req, UseGuards } from '@nestjs/common';

import type { WithdrawalApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
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
import { WithdrawalApplication } from './withdrawal.application';
import { withdrawalRequestBodySchema, type WithdrawalRequestBody } from './withdrawal-request.schema';

/** `POST /internal/v1/withdrawals` — TASK-09's Withdrawal accept endpoint. Same guard chain and
 * intake shape as Mint/Transfer. */
@Controller('internal/v1/withdrawals')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class WithdrawalController {
  private readonly logger = new Logger(WithdrawalController.name);

  constructor(
    private readonly withdrawalApplication: WithdrawalApplication,
    private readonly auditWriter: AuditWriter,
  ) {}

  @Post()
  @RequiresApproval(OperationType.WITHDRAWAL)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(withdrawalRequestBodySchema)) body: WithdrawalRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as WithdrawalApprovalClaims;

    const { operation } = await this.withdrawalApplication.accept(body, approval);

    // TASK-14 §9: isolated from the accept transaction — see MintController for the rationale.
    this.auditWriter
      .writeAudit({
        category: AuditCategory.BUSINESS_EVENT,
        actor: approval.userId,
        action: 'WITHDRAWAL_ACCEPTED',
        target: String(operation.tokenId),
        requestId: request.requestId,
        operationId: operation.id,
        details: { riskAcknowledgementVersion: approval.riskAcknowledgementVersion },
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
