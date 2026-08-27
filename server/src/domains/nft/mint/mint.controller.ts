import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

import type { MintApprovalClaims } from '../../../shared/auth/approval-jwt/approval-jwt-claims';
import {
  ApprovalJwtGuard,
  type RequestWithApproval,
} from '../../../shared/auth/approval-jwt/approval-jwt.guard';
import { RequiresApproval } from '../../../shared/auth/approval-jwt/requires-approval.decorator';
import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { ApiError } from '../../../shared/http/api-error';
import type { OperationAcceptedResponse } from '../../../shared/http/operation-accepted.response';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { OperationIntakeService } from '../../../shared/idempotency/operation-intake.service';
import { computeValidCommandHash } from '../../../shared/idempotency/valid-command-hash';
import { mintRequestBodySchema, type MintRequestBody } from './mint-request.schema';

/**
 * `POST /internal/v1/mints` — TASK-06's guard-chain boundary for Mint acceptance (HMAC ->
 * ApprovalJwtGuard(MINT) -> idempotent Operation intake -> 202). Deliberately does not yet look up
 * the `userId`'s custodial wallet (TASK-05 is not wired in) or acquire an asset lock/dispatch to a
 * worker (TASK-07/10/11): this handler hashes the JWT's claimed `to` directly where TASK-07's
 * `MintApplication.accept()` will instead hash a wallet-lookup-*resolved* `to`, after cross-checking
 * it against this same claim. That replacement only changes this handler's body, not the guards or
 * `OperationIntakeService` plumbing it sits on.
 */
@Controller('internal/v1/mints')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class MintController {
  constructor(private readonly operationIntake: OperationIntakeService) {}

  @Post()
  @RequiresApproval(OperationType.MINT)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(mintRequestBodySchema)) body: MintRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    // Safe: ApprovalJwtGuard already rejected any token whose `purpose` isn't MINT for this route.
    const approval = request.approval as MintApprovalClaims;

    if (
      approval.tokenId !== body.tokenId ||
      approval.userId !== body.userId ||
      approval.cubeId !== body.cubeId
    ) {
      throw new ApiError('APPROVAL_CLAIM_MISMATCH', 'Approval token does not match the request body', 403);
    }

    const validCommandHash = computeValidCommandHash({
      operation: OperationType.MINT,
      tokenId: body.tokenId,
      userId: body.userId,
      cubeId: body.cubeId,
      claimedTo: approval.to,
    });

    const { operation } = await this.operationIntake.acceptApprovedMutation({
      jti: approval.jti,
      operation: {
        idempotencyKey: body.idempotencyKey,
        type: OperationType.MINT,
        requestHash: validCommandHash,
        tokenId: body.tokenId,
        toAddress: approval.to,
      },
    });

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
