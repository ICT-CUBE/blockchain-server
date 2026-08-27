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
  ) {}

  /** Throws `ApiError('IDEMPOTENCY_CONFLICT', ..., 409)` on FR-032's "same key, different
   * content" case, and `ApiError('APPROVAL_JTI_REPLAY', ..., 409)` if `input.jti` was already
   * bound to different content — callers do not need to know about the underlying repository
   * error types. */
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
      throw error;
    }
  }
}
