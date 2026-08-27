import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

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
import { ReentryApplication } from './reentry.application';
import { reentryRequestBodySchema, type ReentryRequestBody } from './reentry-request.schema';

/** `POST /internal/v1/reentries` — TASK-09's Reentry accept endpoint. */
@Controller('internal/v1/reentries')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class ReentryController {
  constructor(private readonly reentryApplication: ReentryApplication) {}

  @Post()
  @RequiresApproval(OperationType.REENTRY)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(reentryRequestBodySchema)) body: ReentryRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as ReentryApprovalClaims;

    const { operation } = await this.reentryApplication.accept(body, approval);

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
