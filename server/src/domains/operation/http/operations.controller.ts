import { Controller, Get, HttpCode, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { ApiError } from '../../../shared/http/api-error';
import { OperationRepository } from '../persistence/operation.repository';
import type { OperationResponse } from './operation.response';

/** `GET /internal/v1/operations/:id` — a stateless read, HMAC only (TASK-06 §4: "Wallet·조회·
 * Metadata 준비는 HMAC만 사용한다"). Returns the confirmed/final result regardless of whether the
 * completion webhook has been delivered yet (TASK-12 §5: this must work "webhook 실패와 무관"). */
@Controller('internal/v1/operations')
@UseGuards(HmacGuard)
export class OperationsController {
  constructor(private readonly operationRepository: OperationRepository) {}

  @Get(':id')
  @HttpCode(200)
  async findById(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<OperationResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }

    return {
      operationId: operation.id,
      type: operation.type,
      status: operation.status,
      tokenId: operation.tokenId,
      fromAddress: operation.fromAddress,
      toAddress: operation.toAddress,
      reviewReason: operation.reviewReason,
      failureCode: operation.failureCode,
      createdAt: operation.createdAt.toISOString(),
      updatedAt: operation.updatedAt.toISOString(),
    };
  }
}
