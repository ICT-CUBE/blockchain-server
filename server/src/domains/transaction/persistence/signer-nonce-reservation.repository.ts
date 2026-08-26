import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

import { SignerNonceReservation } from './signer-nonce-reservation.entity';

/** Thrown when `(chainId, signerAddress, transactionNonce)` was already reserved by another
 * attempt — the caller (TASK-10) should pick the next candidate nonce and retry. */
export class SignerNonceConflictError extends Error {
  constructor(
    public readonly chainId: number,
    public readonly signerAddress: string,
    public readonly transactionNonce: string,
  ) {
    super(`Nonce ${transactionNonce} for signer ${signerAddress} on chain ${chainId} is already reserved`);
    this.name = 'SignerNonceConflictError';
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
export class SignerNonceReservationRepository {
  constructor(private readonly dataSource: DataSource) {}

  /** Atomically claims `transactionNonce` for `signerAddress` on `chainId`, or throws
   * `SignerNonceConflictError` if it is already taken. */
  async reserve(
    chainId: number,
    signerAddress: string,
    transactionNonce: string,
    attemptId: string,
  ): Promise<SignerNonceReservation> {
    const repository = this.dataSource.getRepository(SignerNonceReservation);
    const reservation = repository.create({
      id: randomUUID(),
      chainId,
      signerAddress,
      transactionNonce,
      attemptId,
    });

    try {
      await repository.insert(reservation);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new SignerNonceConflictError(chainId, signerAddress, transactionNonce);
      }
      throw error;
    }

    return reservation;
  }

  /** Highest reserved nonce for a signer on a chain, or null if none has ever been reserved. */
  async findHighestReservedNonce(chainId: number, signerAddress: string): Promise<string | null> {
    const result: unknown = await this.dataSource
      .getRepository(SignerNonceReservation)
      .createQueryBuilder('reservation')
      .select('MAX(reservation.transaction_nonce)', 'maxNonce')
      .where('reservation.chain_id = :chainId', { chainId })
      .andWhere('reservation.signer_address = :signerAddress', { signerAddress })
      .getRawOne();

    const maxNonce = (result as { maxNonce: string | null } | undefined)?.maxNonce;
    return maxNonce ?? null;
  }
}
