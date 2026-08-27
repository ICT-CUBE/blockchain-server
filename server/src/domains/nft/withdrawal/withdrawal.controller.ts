import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

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
import { WithdrawalApplication } from './withdrawal.application';
import { withdrawalRequestBodySchema, type WithdrawalRequestBody } from './withdrawal-request.schema';

/** `POST /internal/v1/withdrawals` — TASK-09's Withdrawal accept endpoint. Same guard chain and
 * intake shape as Mint/Transfer. */
@Controller('internal/v1/withdrawals')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class WithdrawalController {
  constructor(private readonly withdrawalApplication: WithdrawalApplication) {}

  @Post()
  @RequiresApproval(OperationType.WITHDRAWAL)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(withdrawalRequestBodySchema)) body: WithdrawalRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as WithdrawalApprovalClaims;

    const { operation } = await this.withdrawalApplication.accept(body, approval);

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
