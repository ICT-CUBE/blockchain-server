import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { ApiError } from '../../../shared/http/api-error';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { AssetLockRepository } from '../../transaction/persistence/asset-lock.repository';
import { InvalidOperationTransitionError, OperationRepository } from '../persistence/operation.repository';
import type { OperationResponse } from './operation.response';

function toResponse(operation: {
  id: string;
  type: unknown;
  status: unknown;
  tokenId: number;
  fromAddress: string | null;
  toAddress: string | null;
  reviewReason: string | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}): OperationResponse {
  return {
    operationId: operation.id,
    type: operation.type as OperationResponse['type'],
    status: operation.status as OperationResponse['status'],
    tokenId: operation.tokenId,
    fromAddress: operation.fromAddress,
    toAddress: operation.toAddress,
    reviewReason: operation.reviewReason,
    failureCode: operation.failureCode,
    createdAt: operation.createdAt.toISOString(),
    updatedAt: operation.updatedAt.toISOString(),
  };
}

/** `GET /internal/v1/operations/:id` (stateless read) and `POST /internal/v1/operations/:id/cancel`
 * (TASK-08 §5/§7: "제출 전 공식 거래 취소 endpoint는 REQUESTED 상태만 CANCELLED로 전이") — both HMAC
 * only, no approval JWT (TASK-06 §4). GET returns the confirmed/final result regardless of whether
 * the completion webhook has been delivered yet (TASK-12 §5: this must work "webhook 실패와 무관").
 * Cancel is intentionally generic across every Operation type, not Transfer-specific — "not yet
 * submitted, still cancellable" is the same condition everywhere a lock can be held. */
@Controller('internal/v1/operations')
@UseGuards(HmacGuard)
export class OperationsController {
  constructor(
    private readonly operationRepository: OperationRepository,
    private readonly assetLockRepository: AssetLockRepository,
  ) {}

  @Get(':id')
  @HttpCode(200)
  async findById(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<OperationResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }
    return toResponse(operation);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  async cancel(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<OperationResponse> {
    const operation = await this.operationRepository.findById(id);
    if (!operation) {
      throw new ApiError('OPERATION_NOT_FOUND', `No operation with id ${id}`, 404);
    }

    try {
      const cancelled = await this.operationRepository.transition(
        id,
        OperationStatus.REQUESTED,
        OperationStatus.CANCELLED,
        'CANCELLED_BY_REQUEST',
      );
      await this.assetLockRepository.release(cancelled.tokenId);
      return toResponse(cancelled);
    } catch (error) {
      if (error instanceof InvalidOperationTransitionError) {
        throw new ApiError(
          'OPERATION_NOT_CANCELLABLE',
          `Operation ${id} is not in REQUESTED status and can no longer be cancelled`,
          409,
        );
      }
      throw error;
    }
  }
}
