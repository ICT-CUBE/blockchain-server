import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { getAddress } from 'ethers';
import { DataSource, type EntityManager } from 'typeorm';

import { SignerLock } from '../persistence/signer-lock.entity';
import { SignerNonceReservation } from '../persistence/signer-nonce-reservation.entity';
import { RpcService } from '../rpc/rpc.service';

/**
 * Serializes nonce assignment per signer (TASK-10 §5: "signer별 row lock으로 nonce를 직렬 예약"). A
 * `SELECT ... FOR UPDATE` on that signer's `SignerLock` row holds every concurrent caller for the
 * same signer to one at a time for the rest of this method, so the RPC-pending-vs-DB-max comparison
 * and the reservation insert that follows it can never race against another reservation for the
 * same signer.
 */
@Injectable()
export class NonceCoordinator {
  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: RpcService,
  ) {}

  async reserveNext(chainId: number, signerAddress: string, attemptId: string): Promise<string> {
    const normalizedAddress = getAddress(signerAddress);
    // Deliberately outside the reservation transaction below, and using INSERT IGNORE rather than
    // insert-then-catch-duplicate: multiple sessions concurrently inserting the same not-yet-existing
    // unique key and then immediately SELECT ... FOR UPDATE-ing it in the same transaction is a
    // textbook InnoDB deadlock pattern. This first call only matters once per signer (every call
    // after the first is a no-op against an already-existing row), so it doesn't need to share a
    // transaction with the nonce reservation that follows.
    await this.ensureSignerLockRowExists(chainId, normalizedAddress);

    return this.dataSource.transaction(async (manager) => {
      await this.lockSignerRow(manager, chainId, normalizedAddress);

      const [pendingNonce, highestReserved] = await Promise.all([
        this.rpc.getPendingNonce(normalizedAddress),
        this.findHighestReservedNonce(manager, chainId, normalizedAddress),
      ]);

      const nextFromDb = highestReserved !== null ? BigInt(highestReserved) + 1n : null;
      const pendingNonceBig = BigInt(pendingNonce);
      const candidate = nextFromDb !== null && nextFromDb > pendingNonceBig ? nextFromDb : pendingNonceBig;

      await manager.insert(SignerNonceReservation, {
        id: randomUUID(),
        chainId,
        signerAddress: normalizedAddress,
        transactionNonce: candidate.toString(),
        attemptId,
      });

      return candidate.toString();
    });
  }

  private async ensureSignerLockRowExists(chainId: number, signerAddress: string): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(SignerLock)
      .values({ id: randomUUID(), chainId, signerAddress })
      .orIgnore()
      .execute();
  }

  private async lockSignerRow(manager: EntityManager, chainId: number, signerAddress: string): Promise<void> {
    await manager
      .createQueryBuilder(SignerLock, 'lock')
      .setLock('pessimistic_write')
      .where('lock.chain_id = :chainId', { chainId })
      .andWhere('lock.signer_address = :signerAddress', { signerAddress })
      .getOne();
  }

  private async findHighestReservedNonce(
    manager: EntityManager,
    chainId: number,
    signerAddress: string,
  ): Promise<string | null> {
    const result: unknown = await manager
      .createQueryBuilder(SignerNonceReservation, 'reservation')
      .select('MAX(reservation.transaction_nonce)', 'maxNonce')
      .where('reservation.chain_id = :chainId', { chainId })
      .andWhere('reservation.signer_address = :signerAddress', { signerAddress })
      .getRawOne();

    const maxNonce = (result as { maxNonce: string | null } | undefined)?.maxNonce;
    return maxNonce ?? null;
  }
}
