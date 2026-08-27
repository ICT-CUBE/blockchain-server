import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { Transaction } from 'ethers';
import { DataSource, type QueryDeepPartialEntity } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { TransactionAttemptStatus } from '../../../shared/domain/transaction-attempt-status.enum';
import { encryptRawTransaction } from '../encryption/raw-transaction-cipher';
import { NonceCoordinator } from '../nonce/nonce-coordinator.service';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { RpcService } from '../rpc/rpc.service';
import { SystemSignerService } from '../signing/system-signer.service';
import type {
  SubmitTransactionRequest,
  SubmitTransactionResult,
  TransactionSubmissionPort,
} from './transaction-submission.port';

/**
 * Implements `TransactionSubmissionPort` per TASK-10 §5's pipeline: reserve nonce -> build/sign ->
 * compute txHash locally -> encrypt raw tx and commit the attempt row -> broadcast. Signing and DB
 * commit both happen *before* broadcast, so a crash between "signed" and "broadcast" leaves a
 * durable SIGNED attempt that `SignedAttemptRecoveryWorker` can re-broadcast with the exact same
 * signature (same nonce -> same txHash either way).
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
  ) {}

  async submit(request: SubmitTransactionRequest): Promise<SubmitTransactionResult> {
    const attemptId = randomUUID();
    const signerAddress = this.systemSigner.addressFor(request.signerRole);
    const wallet = this.systemSigner.walletFor(request.signerRole);
    const value = request.value ?? 0n;

    const [nonce, fee] = await Promise.all([
      this.nonceCoordinator.reserveNext(request.chainId, signerAddress, attemptId),
      this.rpc.getFeeData(),
    ]);

    const gasLimit = await this.rpc.estimateGas({
      to: request.to,
      data: request.data,
      from: signerAddress,
      value,
    });

    const signedRawTransaction = await wallet.signTransaction({
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

    const txHash = Transaction.from(signedRawTransaction).hash;
    if (!txHash) {
      throw new Error('Signed transaction did not produce a hash');
    }

    const attemptNo = await this.nextAttemptNo(request.operationId);
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

    await this.broadcast(attemptId, signedRawTransaction);

    return { attemptId, attemptNo, txHash };
  }

  /** Used both by `submit()` (attemptNo undefined -> first attempt) and by the pending-monitor's
   * RBF path, which supplies `replacesAttemptId` for a fee-bump replacement of an already-signed
   * attempt (same operation, same intended nonce, higher fee). `gasLimit` is passed in rather than
   * re-estimated: a fee-bump replacement submits byte-for-byte the same call (only the fee differs),
   * so its gas requirement cannot differ from the attempt it replaces — reusing that attempt's own
   * gasLimit is both cheaper and more correct than a fresh `estimateGas`, which on some providers
   * simulates against pending state and would see the still-unconfirmed original as already applied
   * (a false "already minted"/double-spend-shaped revert for a transaction that can never actually
   * conflict with itself). */
  async submitReplacement(params: {
    operationId: string;
    chainId: number;
    signerRole: import('../signing/system-signer.service').SystemSignerRole;
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

    await this.broadcast(attemptId, signedRawTransaction);

    return { attemptId, attemptNo, txHash };
  }

  /** Re-broadcasts an already-SIGNED attempt's stored raw transaction unchanged — used for crash
   * recovery (`SignedAttemptRecoveryWorker`). Never re-signs: the whole point is submitting the
   * identical bytes so the txHash cannot change. */
  async rebroadcast(attemptId: string, decryptedRawTransaction: string): Promise<void> {
    await this.broadcast(attemptId, decryptedRawTransaction);
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
    });
    // See operation.repository.ts for why the relation-carrying entity type forces this cast.
    await repository.insert(entity as unknown as QueryDeepPartialEntity<TransactionAttempt>);
  }

  private async broadcast(attemptId: string, signedRawTransaction: string): Promise<void> {
    try {
      await this.rpc.broadcastTransaction(signedRawTransaction);
      await this.dataSource
        .createQueryBuilder()
        .update(TransactionAttempt)
        .set({ status: TransactionAttemptStatus.BROADCAST, broadcastAt: () => 'CURRENT_TIMESTAMP(3)' })
        .where('id = :attemptId', { attemptId })
        .execute();
    } catch (error) {
      // Deliberately swallowed: the attempt row (with its encrypted raw transaction) is already
      // durably committed at status SIGNED, which is enough for the calling domain worker to
      // consider the Operation "submitted" — `SignedAttemptRecoveryWorker` re-broadcasts it on the
      // next pass. Surfacing this synchronously would make Mint/Transfer acceptance fail on a
      // purely transient broadcast hiccup that self-heals.
      this.logger.warn(
        `Broadcast failed for attempt ${attemptId}, leaving it SIGNED for recovery: ${(error as Error).message}`,
      );
    }
  }
}
