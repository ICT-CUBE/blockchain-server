import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { HmacNonce } from './hmac-nonce.entity';

/** Thrown when `(keyId, nonce)` was already consumed — a replayed request. */
export class HmacNonceReplayError extends Error {
  constructor(
    public readonly keyId: string,
    public readonly nonce: string,
  ) {
    super(`Nonce already used for key ${keyId}`);
    this.name = 'HmacNonceReplayError';
  }
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
export class HmacNonceRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Atomically claims `(keyId, nonce)`, or throws `HmacNonceReplayError` if it was already
   * claimed. Callers must reject the request on that error — never proceed as if it were fresh. */
  async consume(keyId: string, nonce: string): Promise<void> {
    const repository = this.dataSource.getRepository(HmacNonce);
    try {
      await repository.insert({ id: randomUUID(), keyId, nonce });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new HmacNonceReplayError(keyId, nonce);
      }
      throw error;
    }
  }
}
