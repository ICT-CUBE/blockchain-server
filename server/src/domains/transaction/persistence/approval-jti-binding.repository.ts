import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { ApprovalJtiBinding } from './approval-jti-binding.entity';

/** Thrown when `jti` was already bound to a *different* `(idempotencyKey, validCommandHash)` pair
 * — a JWT being replayed against a different command than it was approved for. This is a stronger
 * signal than `IdempotencyConflictError` and should be treated as a security event, not a normal
 * client retry. */
export class ApprovalJtiReplayError extends Error {
  constructor(public readonly jti: string) {
    super(`jti ${jti} was already bound to a different idempotencyKey/command`);
    this.name = 'ApprovalJtiReplayError';
  }
}

export interface BindApprovalJtiInput {
  jti: string;
  idempotencyKey: string;
  validCommandHash: string;
  operationId: string;
}

export interface BindApprovalJtiResult {
  binding: ApprovalJtiBinding;
  /** False when this call resolved to a pre-existing binding for an identical resend. */
  created: boolean;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof error.driverError === 'object' &&
    error.driverError !== null &&
    'code' in error.driverError &&
    (error.driverError as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

@Injectable()
export class ApprovalJtiBindingRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Atomically binds `jti` to `(idempotencyKey, validCommandHash, operationId)`. An exact resend
   * (same jti + same idempotencyKey + same hash) returns the original binding with `created:
   * false`. Reuse of `jti` with different content throws `ApprovalJtiReplayError`. Intended to run
   * in the same DB transaction as the Operation creation it accompanies (TASK-06 §5). */
  async bindOrConflict(input: BindApprovalJtiInput): Promise<BindApprovalJtiResult> {
    const repository = this.dataSource.getRepository(ApprovalJtiBinding);
    const binding = repository.create({
      id: randomUUID(),
      jti: input.jti,
      idempotencyKey: input.idempotencyKey,
      validCommandHash: input.validCommandHash,
      operationId: input.operationId,
    });

    try {
      await repository.insert(binding);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      const existing = await repository.findOneOrFail({ where: { jti: input.jti } });
      const isExactResend =
        existing.idempotencyKey === input.idempotencyKey &&
        existing.validCommandHash === input.validCommandHash;
      if (!isExactResend) {
        throw new ApprovalJtiReplayError(input.jti);
      }
      return { binding: existing, created: false };
    }

    return { binding, created: true };
  }
}
