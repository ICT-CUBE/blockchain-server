/**
 * `npm run fill-nonce-gap -- --signer mint|relayer [--dry-run]`
 *
 * 검증 D1 §10: the *approved operator procedure* for a signer whose pipeline is halted by a nonce
 * gap that no new submission is going to fill (e.g. no traffic, or the gap nonce belongs to a
 * released reservation and the operator wants the queued SIGNED attempts out immediately).
 *
 * What it does — and nothing more:
 * 1. reads the chain's pending nonce for the signer and the lowest SIGNED (never mined) attempt nonce;
 * 2. for every nonce in between (the gap), sends a 0-value self-transfer signed by that signer so
 *    the queued attempts become minable;
 * 3. marks the corresponding reservations ACTIVE (attempt id = the filler tx hash) so the
 *    coordinator never re-uses them, and clears the signer halt.
 *
 * Every filler transaction is logged with its hash. Nothing is written when `--dry-run` is given.
 */
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { Wallet } from 'ethers';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { NonceCoordinator } from '../src/domains/transaction/nonce/nonce-coordinator.service';
import {
  SignerNonceReservation,
  SignerNonceReservationStatus,
} from '../src/domains/transaction/persistence/signer-nonce-reservation.entity';
import { TransactionAttempt } from '../src/domains/transaction/persistence/transaction-attempt.entity';
import { RpcService } from '../src/domains/transaction/rpc/rpc.service';
import { describeRpcError } from '../src/domains/transaction/rpc/rpc-error';
import { SystemSignerService, type SystemSignerRole } from '../src/domains/transaction/signing/system-signer.service';
import { AppConfigService } from '../src/shared/config/app-config.service';
import { TransactionAttemptStatus } from '../src/shared/domain/transaction-attempt-status.enum';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const role = arg('signer') as SystemSignerRole | undefined;
  if (role !== 'mint' && role !== 'relayer') {
    console.error('Usage: npm run fill-nonce-gap -- --signer mint|relayer [--dry-run]');
    process.exitCode = 2;
    return;
  }
  const dryRun = process.argv.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const dataSource = app.get(DataSource);
    const rpc = app.get(RpcService);
    const signers = app.get(SystemSignerService);
    const nonceCoordinator = app.get(NonceCoordinator);
    const appConfig = app.get(AppConfigService);
    const chainId = appConfig.cubeNft.deployment.chainId;
    const signerAddress = signers.addressFor(role);

    const pendingNonce = BigInt(await rpc.getPendingNonce(signerAddress));
    const lowestSigned = await dataSource
      .getRepository(TransactionAttempt)
      .createQueryBuilder('a')
      .select('MIN(a.transaction_nonce)', 'minNonce')
      .where('a.signer_address = :signerAddress', { signerAddress })
      .andWhere('a.chain_id = :chainId', { chainId })
      .andWhere('a.status = :status', { status: TransactionAttemptStatus.SIGNED })
      .getRawOne<{ minNonce: string | null }>();

    console.log(
      JSON.stringify({
        action: 'fill_nonce_gap',
        signer: role,
        signerAddress,
        chainPendingNonce: pendingNonce.toString(),
        lowestSignedAttemptNonce: lowestSigned?.minNonce ?? null,
        halted: await nonceCoordinator.haltReason(chainId, signerAddress),
        dryRun,
        actor: process.env.USER ?? 'unknown',
        at: new Date().toISOString(),
      }),
    );

    if (!lowestSigned?.minNonce || BigInt(lowestSigned.minNonce) <= pendingNonce) {
      console.log('No gap: the lowest SIGNED attempt is at or below the chain pending nonce. Nothing to fill.');
      if (!dryRun) {
        await nonceCoordinator.clearHalt(chainId, signerAddress);
      }
      return;
    }

    const wallet: Wallet = signers.walletFor(role);
    const fee = await rpc.getFeeData();
    for (let nonce = pendingNonce; nonce < BigInt(lowestSigned.minNonce); nonce += 1n) {
      if (dryRun) {
        console.log(`[dry-run] would fill nonce ${nonce} with a 0-value self-transfer from ${signerAddress}`);
        continue;
      }
      const raw = await wallet.signTransaction({
        to: signerAddress,
        value: 0n,
        data: '0x',
        nonce: Number(nonce),
        chainId,
        gasLimit: 21000n,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
        type: 2,
      });
      try {
        await rpc.broadcastTransaction(raw);
      } catch (error) {
        console.error(`filler for nonce ${nonce} failed: ${describeRpcError(error)}`);
        process.exitCode = 1;
        return;
      }
      const txHash = (await import('ethers')).Transaction.from(raw).hash ?? 'unknown';
      await dataSource
        .createQueryBuilder()
        .insert()
        .into(SignerNonceReservation)
        .values({
          id: (await import('node:crypto')).randomUUID(),
          chainId,
          signerAddress,
          transactionNonce: nonce.toString(),
          attemptId: `filler:${txHash.slice(0, 30)}`,
          status: SignerNonceReservationStatus.ACTIVE,
        })
        .orUpdate(['attempt_id', 'status'], ['chain_id', 'signer_address', 'transaction_nonce'])
        .execute();
      console.log(JSON.stringify({ filledNonce: nonce.toString(), txHash }));
    }

    if (!dryRun) {
      await nonceCoordinator.clearHalt(chainId, signerAddress);
      console.log('Signer halt cleared; SignedAttemptRecoveryWorker will re-broadcast the queued attempts.');
    }
  } finally {
    await app.close();
  }
}

void main();
