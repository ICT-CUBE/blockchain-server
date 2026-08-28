import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { getAddress } from 'ethers';
import { DataSource, type EntityManager } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { SignerLock } from '../persistence/signer-lock.entity';
import {
  SignerNonceReservation,
  SignerNonceReservationStatus,
} from '../persistence/signer-nonce-reservation.entity';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { RpcService } from '../rpc/rpc.service';

/** Thrown by `reserveNext` while the signer's circuit breaker is open (a nonce gap was observed on
 * broadcast) and no gap-filling reservation is available to hand out — new MAX+1 nonces would only
 * queue up behind the gap (검증 D1 §8). */
export class SignerHaltedError extends Error {
  constructor(
    public readonly signerAddress: string,
    public readonly reason: string,
  ) {
    super(`Signer ${signerAddress} pipeline is halted (${reason}); refusing to reserve a new nonce`);
    this.name = 'SignerHaltedError';
  }
}

export const SIGNER_HALT_REASON_NONCE_GAP = 'NONCE_GAP';

interface ReusableReservationRow {
  id: string;
  transaction_nonce: string;
}

/**
 * Serializes nonce assignment per signer (TASK-10 §5: "signer별 row lock으로 nonce를 직렬 예약"). A
 * `SELECT ... FOR UPDATE` on that signer's `SignerLock` row holds every concurrent caller for the
 * same signer to one at a time for the rest of this method, so the RPC-pending-vs-DB-max comparison
 * and the reservation insert that follows it can never race against another reservation for the
 * same signer.
 *
 * 검증 D1 additions — the nonce *lifecycle*, not just allocation:
 * - A reservation whose attempt never got committed (fee/estimateGas/sign failed after reserving,
 *   or the process died in between) is `releaseUnused`d / lease-expired and **re-used first**, lowest
 *   nonce first, so a gap closes with the very next submission instead of stranding every higher
 *   nonce behind it.
 * - While the signer is halted (`NONCE_GAP` seen on broadcast), only such gap-filling re-use is
 *   allowed; a fresh MAX+1 reservation is refused with `SignerHaltedError`. The halt clears itself
 *   once the chain's pending nonce has caught up with everything reserved, or on the next
 *   successful broadcast for that signer.
 */
@Injectable()
export class NonceCoordinator {
  private readonly logger = new Logger(NonceCoordinator.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: RpcService,
    private readonly appConfig: AppConfigService,
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
      const lock = await this.lockSignerRow(manager, chainId, normalizedAddress);

      const [pendingNonce, highestReserved] = await Promise.all([
        this.rpc.getPendingNonce(normalizedAddress),
        this.findHighestReservedNonce(manager, chainId, normalizedAddress),
      ]);
      const pendingNonceBig = BigInt(pendingNonce);

      // 1) Gap fill first: the lowest released/orphaned nonce at or above the chain's pending nonce
      //    is exactly the hole every higher SIGNED attempt is waiting on.
      const reusable = await this.findReusableReservation(
        manager,
        chainId,
        normalizedAddress,
        pendingNonceBig,
      );
      if (reusable) {
        await manager
          .createQueryBuilder()
          .update(SignerNonceReservation)
          .set({
            attemptId,
            status: SignerNonceReservationStatus.ACTIVE,
            reservedAt: () => 'CURRENT_TIMESTAMP(3)',
          })
          .where('id = :id', { id: reusable.id })
          .execute();
        this.logger.log(
          `Re-using released nonce ${reusable.transaction_nonce} for signer ${normalizedAddress} (gap fill) -> attempt ${attemptId}`,
        );
        return reusable.transaction_nonce;
      }

      // 2) Circuit breaker: no gap to fill, but a gap was observed — refuse to stack more nonces
      //    behind it unless the chain has meanwhile caught up (gap resolved externally).
      if (lock?.haltedReason) {
        const caughtUp = highestReserved === null || BigInt(highestReserved) < pendingNonceBig;
        if (!caughtUp) {
          throw new SignerHaltedError(normalizedAddress, lock.haltedReason);
        }
        await this.clearHaltWithManager(manager, chainId, normalizedAddress);
      }

      // 3) Normal allocation: max(RPC pending, DB highest + 1).
      const nextFromDb = highestReserved !== null ? BigInt(highestReserved) + 1n : null;
      const candidate = nextFromDb !== null && nextFromDb > pendingNonceBig ? nextFromDb : pendingNonceBig;

      await manager.insert(SignerNonceReservation, {
        id: randomUUID(),
        chainId,
        signerAddress: normalizedAddress,
        transactionNonce: candidate.toString(),
        attemptId,
        status: SignerNonceReservationStatus.ACTIVE,
      });

      return candidate.toString();
    });
  }

  /** Gives a reservation back when its attempt was never committed (fee/estimateGas/sign/insert
   * failed after `reserveNext`). Refuses — silently — to release a nonce that *does* have a
   * committed attempt: that raw transaction may already be in a mempool and must be recovered, not
   * re-assigned (검증 D1 §5). Runs under the signer lock so it cannot interleave with a concurrent
   * `reserveNext` for the same signer. */
  async releaseUnused(
    chainId: number,
    signerAddress: string,
    transactionNonce: string,
    attemptId: string,
  ): Promise<boolean> {
    const normalizedAddress = getAddress(signerAddress);
    return this.dataSource.transaction(async (manager) => {
      await this.lockSignerRow(manager, chainId, normalizedAddress);
      const committed = await manager.count(TransactionAttempt, { where: { id: attemptId } });
      if (committed > 0) {
        return false;
      }
      const result = await manager
        .createQueryBuilder()
        .update(SignerNonceReservation)
        .set({ status: SignerNonceReservationStatus.RELEASED })
        .where('chain_id = :chainId', { chainId })
        .andWhere('signer_address = :signerAddress', { signerAddress: normalizedAddress })
        .andWhere('transaction_nonce = :transactionNonce', { transactionNonce })
        .andWhere('attempt_id = :attemptId', { attemptId })
        .execute();
      const released = (result.affected ?? 0) > 0;
      if (released) {
        this.logger.warn(
          `Released unused nonce ${transactionNonce} for signer ${normalizedAddress} (attempt ${attemptId} was never committed)`,
        );
      }
      return released;
    });
  }

  /** Opens the signer's circuit breaker. Idempotent — a second observation of the same gap keeps
   * the original `haltedAt`. */
  async haltSigner(chainId: number, signerAddress: string, reason: string): Promise<void> {
    const normalizedAddress = getAddress(signerAddress);
    await this.ensureSignerLockRowExists(chainId, normalizedAddress);
    await this.dataSource
      .createQueryBuilder()
      .update(SignerLock)
      .set({ haltedReason: reason, haltedAt: () => 'CURRENT_TIMESTAMP(3)' })
      .where('chain_id = :chainId', { chainId })
      .andWhere('signer_address = :signerAddress', { signerAddress: normalizedAddress })
      .andWhere('halted_reason IS NULL')
      .execute();
  }

  async clearHalt(chainId: number, signerAddress: string): Promise<void> {
    await this.clearHaltWithManager(this.dataSource.manager, chainId, getAddress(signerAddress));
  }

  async haltReason(chainId: number, signerAddress: string): Promise<string | null> {
    const lock = await this.dataSource
      .getRepository(SignerLock)
      .findOne({ where: { chainId, signerAddress: getAddress(signerAddress) } });
    return lock?.haltedReason ?? null;
  }

  private async clearHaltWithManager(
    manager: EntityManager,
    chainId: number,
    signerAddress: string,
  ): Promise<void> {
    const result = await manager
      .createQueryBuilder()
      .update(SignerLock)
      .set({ haltedReason: null, haltedAt: null })
      .where('chain_id = :chainId', { chainId })
      .andWhere('signer_address = :signerAddress', { signerAddress })
      .andWhere('halted_reason IS NOT NULL')
      .execute();
    if ((result.affected ?? 0) > 0) {
      this.logger.log(`Signer ${signerAddress} pipeline resumed (halt cleared)`);
    }
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

  private async lockSignerRow(
    manager: EntityManager,
    chainId: number,
    signerAddress: string,
  ): Promise<SignerLock | null> {
    return manager
      .createQueryBuilder(SignerLock, 'lock')
      .setLock('pessimistic_write')
      .where('lock.chain_id = :chainId', { chainId })
      .andWhere('lock.signer_address = :signerAddress', { signerAddress })
      .getOne();
  }

  /** Lowest nonce >= `pendingNonce` that is RELEASED, or ACTIVE-but-orphaned (no committed attempt
   * and past the reservation lease). Rows below the pending nonce are history (already mined). */
  private async findReusableReservation(
    manager: EntityManager,
    chainId: number,
    signerAddress: string,
    pendingNonce: bigint,
  ): Promise<ReusableReservationRow | null> {
    const leaseCutoff = new Date(Date.now() - this.appConfig.submission.nonceReservationLeaseMs);
    const rows: unknown = await manager.query(
      `SELECT r.id AS id, CAST(r.transaction_nonce AS CHAR) AS transaction_nonce
         FROM signer_nonce_reservations r
         LEFT JOIN transaction_attempts a ON a.id = r.attempt_id
        WHERE r.chain_id = ?
          AND r.signer_address = ?
          AND r.transaction_nonce >= ?
          AND (r.status = ? OR (r.status = ? AND a.id IS NULL AND r.reserved_at < ?))
        ORDER BY r.transaction_nonce ASC
        LIMIT 1
        FOR UPDATE`,
      [
        chainId,
        signerAddress,
        pendingNonce.toString(),
        SignerNonceReservationStatus.RELEASED,
        SignerNonceReservationStatus.ACTIVE,
        leaseCutoff,
      ],
    );
    const first = Array.isArray(rows) ? (rows[0] as ReusableReservationRow | undefined) : undefined;
    return first ?? null;
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
