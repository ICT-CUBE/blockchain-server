import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'ethers';
import { DataSource, In, type QueryDeepPartialEntity } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { AuditWriter } from '../../audit/application/audit-writer';
import { FailureCode } from '../../audit/persistence/failure-record.entity';
import { Operation } from '../../operation/persistence/operation.entity';
import { OperationRepository } from '../../operation/persistence/operation.repository';
import { encryptRawTransaction } from '../encryption/raw-transaction-cipher';
import { NonceCoordinator, SIGNER_HALT_REASON_NONCE_GAP } from '../nonce/nonce-coordinator.service';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { describeRpcError, summarizeRpcError, type RpcErrorSummary } from '../rpc/rpc-error';
import { RpcService } from '../rpc/rpc.service';
import { SystemSignerService, type SystemSignerRole } from '../signing/system-signer.service';
import type {
  SubmitTransactionRequest,
  SubmitTransactionResult,
  TransactionSubmissionPort,
} from './transaction-submission.port';

export type BroadcastOutcome =
  | { status: 'BROADCAST' }
  | { status: 'RETRY_SCHEDULED'; error: RpcErrorSummary; nextBroadcastAt: Date }
  | { status: 'ESCALATED'; error: RpcErrorSummary };

/** Operation statuses a broadcast escalation may move to REVIEW_REQUIRED from. */
const ESCALATABLE_OPERATION_STATUSES = new Set<OperationStatus>([
  OperationStatus.REQUESTED,
  OperationStatus.SUBMITTED,
  OperationStatus.PENDING,
]);

/**
 * Implements `TransactionSubmissionPort` per TASK-10 §5 with the 검증 D1 ordering:
 *
 * ```text
 * estimateGas · fee  →  reserve nonce  →  sign · persist SIGNED attempt  →  broadcast
 * ```
 *
 * - Everything that can fail for reasons unrelated to the nonce (fee lookup, gas estimation —
 *   including a deterministic revert of the calldata) runs **before** a nonce is reserved, so such
 *   failures never leave a hole in the signer's nonce sequence.
 * - A failure between reservation and the committed SIGNED row (signing, attempt insert) releases
 *   the reservation so the next submission re-uses that nonce.
 * - Once the SIGNED row is committed the nonce is spoken for: a broadcast failure never releases
 *   or supersedes it. The stored raw transaction is re-broadcast unchanged by
 *   `SignedAttemptRecoveryWorker` with exponential backoff; broadcast errors are classified
 *   (`rpc-error.ts`) so a `nonce too high` opens the signer's circuit breaker, a permanent reject
 *   or an exhausted retry budget escalates the attempt/Operation to REVIEW_REQUIRED with a failure
 *   record, and only a short redacted summary is ever logged (검증 D11).
 */
@Injectable()
export class TransactionSubmissionService implements TransactionSubmissionPort {
  private readonly logger = new Logger(TransactionSubmissionService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly nonceCoordinator: NonceCoordinator,
    private readonly rpc: RpcService,
    private readonly systemSigner: SystemSignerService,
    private readonly appConfig: AppConfigService,
    private readonly operationRepository: OperationRepository,
    private readonly auditWriter: AuditWriter,
  ) {}

  async submit(request: SubmitTransactionRequest): Promise<SubmitTransactionResult> {
    const signerAddress = this.systemSigner.addressFor(request.signerRole);
    const wallet = this.systemSigner.walletFor(request.signerRole);
    const value = request.value ?? 0n;

    // Stage 1 — no nonce is held yet, so any failure here (RPC outage, or a deterministic revert of
    // this calldata) simply propagates to the caller without touching the nonce sequence.
    const [fee, gasLimit] = await Promise.all([
      this.rpc.getFeeData(),
      this.rpc.estimateGas({ to: request.to, data: request.data, from: signerAddress, value }),
    ]);

    // Stage 2 — reserve (may throw SignerHaltedError while a gap is open and nothing can fill it).
    const attemptId = randomUUID();
    const nonce = await this.nonceCoordinator.reserveNext(request.chainId, signerAddress, attemptId);

    // Stage 3 — sign and durably commit the SIGNED attempt; on failure give the nonce back.
    let signedRawTransaction: string;
    let txHash: string;
    let attemptNo: number;
    try {
      signedRawTransaction = await wallet.signTransaction({
        to: request.to,
        data: request.data,
        value,
        nonce: Number(nonce),
        chainId: request.chainId,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        gasLimit,
        type: 2,
      });
      txHash = Transaction.from(signedRawTransaction).hash ?? '';
      if (!txHash) {
        throw new Error('Signed transaction did not produce a hash');
      }
      attemptNo = await this.nextAttemptNo(request.operationId);
      await this.commitAttempt({
        id: attemptId,
        operationId: request.operationId,
        attemptNo,
        chainId: request.chainId,
        signerAddress,
        transactionNonce: nonce,
        txHash,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        signedRawTransaction,
        replacesAttemptId: null,
      });
    } catch (error) {
      await this.nonceCoordinator
        .releaseUnused(request.chainId, signerAddress, nonce, attemptId)
        .catch((releaseError: unknown) => {
          this.logger.error(
            `Could not release nonce ${nonce} for signer ${signerAddress} after a pre-commit failure: ${(releaseError as Error).message}`,
          );
        });
      throw error;
    }

    // Stage 4 — broadcast. Failure here is *not* an error for the caller: the SIGNED row is durable
    // and will be re-broadcast by the recovery worker (or escalated, see `broadcast`).
    await this.broadcast(attemptId, request.chainId, signerAddress, signedRawTransaction, 0);

    return { attemptId, attemptNo, txHash };
  }

  /** Used by the pending-monitor's RBF path, which supplies `replacesAttemptId` for a fee-bump
   * replacement of an already-signed attempt (same operation, same intended nonce, higher fee).
   * `gasLimit` is passed in rather than re-estimated: a fee-bump replacement submits byte-for-byte
   * the same call (only the fee differs), so its gas requirement cannot differ from the attempt it
   * replaces — reusing that attempt's own gasLimit is both cheaper and more correct than a fresh
   * `estimateGas`, which on some providers simulates against pending state and would see the
   * still-unconfirmed original as already applied. */
  async submitReplacement(params: {
    operationId: string;
    chainId: number;
    signerRole: SystemSignerRole;
    to: string;
    data: string;
    value: bigint;
    nonce: string;
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    replacesAttemptId: string;
  }): Promise<SubmitTransactionResult> {
    const attemptId = randomUUID();
    const signerAddress = this.systemSigner.addressFor(params.signerRole);
    const wallet = this.systemSigner.walletFor(params.signerRole);

    const signedRawTransaction = await wallet.signTransaction({
      to: params.to,
      data: params.data,
      value: params.value,
      nonce: Number(params.nonce),
      chainId: params.chainId,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      gasLimit: params.gasLimit,
      type: 2,
    });

    const txHash = Transaction.from(signedRawTransaction).hash;
    if (!txHash) {
      throw new Error('Signed transaction did not produce a hash');
    }

    const attemptNo = await this.nextAttemptNo(params.operationId);
    await this.commitAttempt({
      id: attemptId,
      operationId: params.operationId,
      attemptNo,
      chainId: params.chainId,
      signerAddress,
      transactionNonce: params.nonce,
      txHash,
      maxFeePerGas: params.maxFeePerGas,
      maxPriorityFeePerGas: params.maxPriorityFeePerGas,
      signedRawTransaction,
      replacesAttemptId: params.replacesAttemptId,
    });

    await this.broadcast(attemptId, params.chainId, signerAddress, signedRawTransaction, 0);

    return { attemptId, attemptNo, txHash };
  }

  /** Re-broadcasts an already-SIGNED attempt's stored raw transaction unchanged — used for crash
   * recovery (`SignedAttemptRecoveryWorker`). Never re-signs: the whole point is submitting the
   * identical bytes so the txHash cannot change. */
  async rebroadcast(attempt: TransactionAttempt, decryptedRawTransaction: string): Promise<BroadcastOutcome> {
    return this.broadcast(
      attempt.id,
      attempt.chainId,
      attempt.signerAddress,
      decryptedRawTransaction,
      attempt.broadcastAttemptCount,
    );
  }

  /** Exponential backoff for broadcast retries: `poll * 2^(n-1)` capped, plus up to 20% jitter. */
  computeBroadcastBackoffMs(attemptCount: number): number {
    const base = this.appConfig.submission.pollIntervalMs;
    const cap = this.appConfig.submission.broadcastMaxBackoffMs;
    const exponential = Math.min(base * 2 ** Math.max(attemptCount - 1, 0), cap);
    const jitter = Math.random() * exponential * 0.2;
    return Math.min(Math.round(exponential + jitter), cap);
  }

  private async nextAttemptNo(operationId: string): Promise<number> {
    const count = await this.dataSource.getRepository(TransactionAttempt).count({ where: { operationId } });
    return count + 1;
  }

  private async commitAttempt(params: {
    id: string;
    operationId: string;
    attemptNo: number;
    chainId: number;
    signerAddress: string;
    transactionNonce: string;
    txHash: string;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    signedRawTransaction: string;
    replacesAttemptId: string | null;
  }): Promise<void> {
    const repository = this.dataSource.getRepository(TransactionAttempt);
    const ciphertext = encryptRawTransaction(
      this.appConfig.submission.rawTxEncryptionKey,
      params.signedRawTransaction,
    );
    const entity = repository.create({
      id: params.id,
      operationId: params.operationId,
      attemptNo: params.attemptNo,
      chainId: params.chainId,
      signerAddress: params.signerAddress,
      transactionNonce: params.transactionNonce,
      txHash: params.txHash,
      status: TransactionAttemptStatus.SIGNED,
      maxFeePerGasWei: params.maxFeePerGas.toString(),
      maxPriorityFeePerGasWei: params.maxPriorityFeePerGas.toString(),
      rawTransactionCiphertext: ciphertext,
      rawTransactionPurgedAt: null,
      replacesAttemptId: params.replacesAttemptId,
      broadcastAttemptCount: 0,
      nextBroadcastAt: null,
      lastBroadcastError: null,
    });
    // See operation.repository.ts for why the relation-carrying entity type forces this cast.
    await repository.insert(entity as unknown as QueryDeepPartialEntity<TransactionAttempt>);
  }

  /**
   * One broadcast try of an already-committed SIGNED attempt. Never throws for RPC failures — the
   * outcome is recorded on the attempt row (count, redacted error, next retry time) and returned:
   *
   * - success ("already known"/"nonce too low" count as success, see `RpcService`): attempt →
   *   BROADCAST, signer halt cleared.
   * - `nonce too high`: signer circuit breaker opened + `SIGNER_NONCE_GAP` failure record; retried
   *   with backoff without consuming the retry budget (the gap, not this attempt, is the problem).
   * - permanent reject / insufficient funds / revert-at-broadcast, or transient failures past
   *   `broadcastMaxRetries`: attempt → REVIEW_REQUIRED, Operation → REVIEW_REQUIRED,
   *   `BROADCAST_RETRY_EXHAUSTED` failure record.
   * - other transient failures: retry scheduled with exponential backoff.
   */
  private async broadcast(
    attemptId: string,
    chainId: number,
    signerAddress: string,
    signedRawTransaction: string,
    priorAttemptCount: number,
  ): Promise<BroadcastOutcome> {
    const attemptCount = priorAttemptCount + 1;
    try {
      await this.rpc.broadcastTransaction(signedRawTransaction);
    } catch (error) {
      return this.handleBroadcastFailure(attemptId, chainId, signerAddress, attemptCount, error);
    }

    await this.dataSource
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({
        status: TransactionAttemptStatus.BROADCAST,
        broadcastAt: () => 'CURRENT_TIMESTAMP(3)',
        broadcastAttemptCount: attemptCount,
        nextBroadcastAt: null,
        lastBroadcastError: null,
      })
      .where('id = :attemptId', { attemptId })
      .andWhere('status = :signed', { signed: TransactionAttemptStatus.SIGNED })
      .execute();

    await this.nonceCoordinator.clearHalt(chainId, signerAddress).catch((error: unknown) => {
      this.logger.warn(`Could not clear signer halt for ${signerAddress}: ${(error as Error).message}`);
    });
    return { status: 'BROADCAST' };
  }

  private async handleBroadcastFailure(
    attemptId: string,
    chainId: number,
    signerAddress: string,
    attemptCount: number,
    error: unknown,
  ): Promise<BroadcastOutcome> {
    const summary = summarizeRpcError(error);
    const described = describeRpcError(error).slice(0, 255);
    const isGap = summary.class === 'NONCE_TOO_HIGH';
    const isPermanent =
      summary.class === 'PERMANENT_REJECT' ||
      summary.class === 'INSUFFICIENT_FUNDS' ||
      summary.class === 'REVERT';
    const budgetExhausted = !isGap && attemptCount >= this.appConfig.submission.broadcastMaxRetries;

    if (isPermanent || budgetExhausted) {
      await this.dataSource
        .createQueryBuilder()
        .update(TransactionAttempt)
        .set({
          status: TransactionAttemptStatus.REVIEW_REQUIRED,
          broadcastAttemptCount: attemptCount,
          nextBroadcastAt: null,
          lastBroadcastError: described,
        })
        .where('id = :attemptId', { attemptId })
        .andWhere('status = :signed', { signed: TransactionAttemptStatus.SIGNED })
        .execute();
      await this.escalateOperation(attemptId, signerAddress, attemptCount, summary, isPermanent);
      this.logger.warn(
        `Broadcast of attempt ${attemptId} escalated to REVIEW_REQUIRED after ${attemptCount} tr${attemptCount === 1 ? 'y' : 'ies'} (${described})`,
      );
      return { status: 'ESCALATED', error: summary };
    }

    // 검증 문제 1: schedule the retry against the DB clock (`DATE_ADD(NOW(3), …)`), not the app's
    // `new Date()`, so `SignedAttemptRecoveryWorker` — which now compares with `NOW(3)` — always
    // agrees on whether the backoff has elapsed, even on a non-UTC-hosted or multi-process
    // deployment. The `Date` below is only an approximation used for the log line and the return
    // value's type contract; nothing keys off its exact value.
    const backoffMs = this.computeBroadcastBackoffMs(attemptCount);
    const backoffMicros = Math.round(backoffMs * 1000);
    const nextBroadcastAt = new Date(Date.now() + backoffMs);
    await this.dataSource
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({
        broadcastAttemptCount: attemptCount,
        nextBroadcastAt: () => `DATE_ADD(NOW(3), INTERVAL ${backoffMicros} MICROSECOND)`,
        lastBroadcastError: described,
      })
      .where('id = :attemptId', { attemptId })
      .andWhere('status = :signed', { signed: TransactionAttemptStatus.SIGNED })
      .execute();

    if (isGap) {
      await this.nonceCoordinator
        .haltSigner(chainId, signerAddress, SIGNER_HALT_REASON_NONCE_GAP)
        .catch((haltError: unknown) => {
          this.logger.error(`Could not halt signer ${signerAddress}: ${(haltError as Error).message}`);
        });
      await this.recordNonceGap(attemptId, signerAddress, attemptCount, described);
    }

    // Rate-limited logging: the first failure, then every 10th, plus every state change above.
    if (attemptCount === 1 || attemptCount % 10 === 0) {
      this.logger.warn(
        `Broadcast failed for attempt ${attemptId} (try ${attemptCount}, next at ${nextBroadcastAt.toISOString()}), leaving it SIGNED for recovery: ${described}`,
      );
    }
    return { status: 'RETRY_SCHEDULED', error: summary, nextBroadcastAt };
  }

  private async escalateOperation(
    attemptId: string,
    signerAddress: string,
    attemptCount: number,
    summary: RpcErrorSummary,
    permanent: boolean,
  ): Promise<void> {
    const attempt = await this.dataSource
      .getRepository(TransactionAttempt)
      .findOne({ where: { id: attemptId } });
    if (!attempt) {
      return;
    }
    const reason = permanent ? 'BROADCAST_REJECTED' : 'BROADCAST_RETRY_EXHAUSTED';
    const operation = await this.dataSource.getRepository(Operation).findOne({
      where: { id: attempt.operationId, status: In([...ESCALATABLE_OPERATION_STATUSES]) },
    });
    if (operation) {
      try {
        await this.operationRepository.transition(
          operation.id,
          operation.status,
          OperationStatus.REVIEW_REQUIRED,
          reason,
        );
      } catch {
        // Moved concurrently — the failure record below still documents what happened.
      }
    }
    await this.auditWriter
      .writeFailure({
        code: FailureCode.BROADCAST_RETRY_EXHAUSTED,
        operationId: attempt.operationId,
        attemptId,
        details: {
          reason,
          signerAddress,
          transactionNonce: attempt.transactionNonce,
          retryCount: attemptCount,
          errorClass: summary.class,
          errorCode: summary.code,
          lastError: summary.reason,
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(`Failure-record write failed for attempt ${attemptId}: ${(error as Error).message}`);
      });
  }

  private async recordNonceGap(
    attemptId: string,
    signerAddress: string,
    attemptCount: number,
    described: string,
  ): Promise<void> {
    const attempt = await this.dataSource
      .getRepository(TransactionAttempt)
      .findOne({ where: { id: attemptId } });
    if (!attempt) {
      return;
    }
    await this.auditWriter
      .writeFailureOnce({
        code: FailureCode.SIGNER_NONCE_GAP,
        operationId: attempt.operationId,
        attemptId,
        details: {
          signerAddress,
          transactionNonce: attempt.transactionNonce,
          retryCount: attemptCount,
          lastError: described,
          recovery:
            'Fill the lower nonce (next submission re-uses a released reservation automatically, or run `npm run fill-nonce-gap --workspace=server`), then the signer resumes on the next successful broadcast.',
        },
      })
      .catch((error: unknown) => {
        this.logger.warn(`Failure-record write failed for attempt ${attemptId}: ${(error as Error).message}`);
      });
  }
}
