import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';

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
import { ExternalResaleApplication } from './external-resale.application';
import {
  externalResaleRequestBodySchema,
  type ExternalResaleRequestBody,
} from './external-resale-request.schema';

/** `POST /internal/v1/external-resales` — TASK-09's External-Resale accept endpoint. */
@Controller('internal/v1/external-resales')
@UseGuards(HmacGuard, ApprovalJwtGuard)
export class ExternalResaleController {
  constructor(private readonly externalResaleApplication: ExternalResaleApplication) {}

  @Post()
  @RequiresApproval(OperationType.EXTERNAL_RESALE)
  @HttpCode(202)
  async accept(
    @Body(new ZodValidationPipe(externalResaleRequestBodySchema)) body: ExternalResaleRequestBody,
    @Req() request: RequestWithApproval,
  ): Promise<OperationAcceptedResponse> {
    const approval = request.approval as ExternalResaleApprovalClaims;

    const { operation } = await this.externalResaleApplication.accept(body, approval);

    return {
      operationId: operation.id,
      status: operation.status,
      type: operation.type,
      tokenId: operation.tokenId,
    };
  }
}
