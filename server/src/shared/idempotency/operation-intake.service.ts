import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  IdempotencyConflictError,
  OperationRepository,
  type CreateOrGetOperationInput,
} from '../../domains/operation/persistence/operation.repository';
import {
  ApprovalJtiBindingRepository,
  ApprovalJtiReplayError,
} from '../../domains/transaction/persistence/approval-jti-binding.repository';
import {
  AssetLockConflictError,
  AssetLockRepository,
} from '../../domains/transaction/persistence/asset-lock.repository';
import type { Operation } from '../../domains/operation/persistence/operation.entity';
import { ApiError } from '../http/api-error';

export interface AcceptApprovedMutationInput {
  jti: string;
  operation: CreateOrGetOperationInput;
}

export interface AcceptApprovedMutationResult {
  operation: Operation;
  created: boolean;
}

/**
 * Shared intake boundary for every JWT-approved mutation (Mint now; Transfer/Withdrawal/
 * Reentry/External Resale in TASK-08/09) — atomically creates-or-gets the Operation and binds the
 * approval's `jti` to it in a single DB transaction, exactly as TASK-06 §5 requires ("jti+
 * idempotencyKey+유효 명령 hash binding과 Operation 생성을 같은 DB transaction으로 처리"). Individual
 * repositories accept an optional `EntityManager` for this reason; this service is what actually
 * opens that one shared transaction around both of them.
 */
@Injectable()
export class OperationIntakeService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly operationRepository: OperationRepository,
    private readonly approvalJtiBindingRepository: ApprovalJtiBindingRepository,
    private readonly assetLockRepository: AssetLockRepository,
  ) {}

  /** Throws `ApiError('IDEMPOTENCY_CONFLICT', ..., 409)` on FR-032's "same key, different
   * content" case, `ApiError('APPROVAL_JTI_REPLAY', ..., 409)` if `input.jti` was already bound to
   * different content, and `ApiError('ASSET_LOCK_CONFLICT', ..., 409)` if another Operation already
   * holds the single allowed active lock on this tokenId (FR-019/020) — callers do not need to know
   * about the underlying repository error types.
   *
   * The lock is only acquired when this call actually creates a new Operation: a retried request
   * for an existing `idempotencyKey` returns the same Operation, which already acquired its lock
   * the first time (or has since released it on completion — re-acquiring here would be wrong
   * either way). */
  async acceptApprovedMutation(input: AcceptApprovedMutationInput): Promise<AcceptApprovedMutationResult> {
    try {
      return await this.dataSource.transaction('READ COMMITTED', async (manager) => {
        const { operation, created } = await this.operationRepository.createOrGet(input.operation, manager);
        await this.approvalJtiBindingRepository.bindOrConflict(
          {
            jti: input.jti,
            idempotencyKey: input.operation.idempotencyKey,
            validCommandHash: input.operation.requestHash,
            operationId: operation.id,
          },
          manager,
        );
        if (created) {
          await this.assetLockRepository.acquire(input.operation.tokenId, operation.id, manager);
        }
        return { operation, created };
      });
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ApiError(
          'IDEMPOTENCY_CONFLICT',
          `idempotencyKey ${error.idempotencyKey} was already used with different request content`,
          409,
        );
      }
      if (error instanceof ApprovalJtiReplayError) {
        throw new ApiError(
          'APPROVAL_JTI_REPLAY',
          'Approval token was already used for a different request',
          409,
        );
      }
      if (error instanceof AssetLockConflictError) {
        throw new ApiError(
          'ASSET_LOCK_CONFLICT',
          `tokenId ${error.tokenId} already has a conflicting operation in progress`,
          409,
        );
      }
      throw error;
    }
  }
}
