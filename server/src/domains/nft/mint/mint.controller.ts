import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

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
  constructor(private readonly mintApplication: MintApplication) {}

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

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
