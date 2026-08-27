import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

import type { TransferApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import {
  ApprovalJwtGuard,
  type RequestWithApproval,
} from '../../../shared/auth/approval-jwt/approval-jwt.guard';
import { RequiresApproval } from '../../../shared/auth/approval-jwt/requires-approval.decorator';
import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import type { OperationAcceptedResponse } from '../../../shared/http/operation-accepted.response';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { TransferApplication } from './transfer.application';
import { transferRequestBodySchema, type TransferRequestBody } from './transfer-request.schema';

/**
 * `POST /internal/v1/transfers` (the plan's own §7 shorthand is "POST /transfers"; namespaced under
 * `internal/v1` here for consistency with every other endpoint — TASK-01/06) — TASK-06's guard chain
 * (HMAC -> ApprovalJwtGuard(TRANSFER)) around TASK-08's `TransferApplication.accept()`, which
 * resolves both the seller's and buyer's custodial wallets, cross-checks them against the approval
 * token, and atomically creates the Operation + asset lock + jti binding.
 */
@Controller('internal/v1/transfers')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class TransferController {
  constructor(private readonly transferApplication: TransferApplication) {}

  @Post()
  @RequiresApproval(OperationType.TRANSFER)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(transferRequestBodySchema)) body: TransferRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    // Safe: ApprovalJwtGuard already rejected any token whose `purpose` isn't TRANSFER for this route.
    const approval = request.approval as TransferApprovalClaims;

    const { operation } = await this.transferApplication.accept(body, approval);

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
