import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface, Transaction, Wallet } from 'ethers';
import { In, type DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { TransactionAttemptStatus } from '../../src/shared/domain/transaction-attempt-status.enum';
import { AuditWriter } from '../../src/domains/audit/application/audit-writer';
import { AuditRecord } from '../../src/domains/audit/persistence/audit-record.entity';
import { FailureRecord } from '../../src/domains/audit/persistence/failure-record.entity';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { encryptRawTransaction } from '../../src/domains/transaction/encryption/raw-transaction-cipher';
import { NonceCoordinator } from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { TransactionAttempt } from '../../src/domains/transaction/persistence/transaction-attempt.entity';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { PendingMonitorWorker } from '../../src/domains/transaction/submission/pending-monitor.worker';
import { SignedAttemptRecoveryWorker } from '../../src/domains/transaction/submission/signed-attempt-recovery.worker';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { unmintedTokenId } from '../helpers/unminted-token-id';
import { createTestDataSource } from './test-data-source';

/**
 * Exercises TASK-10 against a real, currently-running `hardhat node` (started separately: `npm run
 * node --workspace=@cube-nft/contracts`, then `npx hardhat run scripts/deploy.ts --network
 * localhost` from `contracts/cube-nft`) — not mocked RPC. Skips itself if that node isn't reachable
 * (matches `createTestDataSource`'s "throw at beforeAll rather than silently pass against nothing"
 * philosophy for the DB, applied here to the chain instead).
 */

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
// Hardhat's well-known dev mnemonic accounts #1 (minter) / #2 (relayer) — see deploy.ts's local
// fallback and app-config.ts's LOCAL_DEV_*_PRIVATE_KEY, which these intentionally match so the
// `localhost` deployment's on-chain roles line up with what this test signs with.
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');

function setEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.CUBE_NFT_NETWORK = 'localhost';
  process.env.CUBE_NFT_DEPLOYMENTS_DIR = CONTRACTS_DEPLOYMENTS_DIR;
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft_test_pw@127.0.0.1:3307/cube_nft_test';
  process.env.HMAC_INBOUND_KEY_ID = 'backend-v1';
  process.env.HMAC_INBOUND_KEY_SECRET = Buffer.alloc(32, 1).toString('base64url');
  process.env.HMAC_OPERATOR_KEY_ID = 'operator-v1';
  process.env.HMAC_OPERATOR_KEY_SECRET = Buffer.alloc(32, 101).toString('base64url');
  process.env.APPROVAL_JWT_SECRET = Buffer.alloc(32, 2).toString('base64url');
  process.env.APPROVAL_JWT_ISSUER = 'arzone-backend';
  process.env.APPROVAL_JWT_AUDIENCE = 'arzone-blockchain-server';
  process.env.RAW_TX_ENCRYPTION_KEY = RAW_TX_ENCRYPTION_KEY;
  process.env.TRANSACTION_RPC_URL_PRIMARY = RPC_URL;
  process.env.MINT_SIGNER_PRIVATE_KEY = MINT_SIGNER_PRIVATE_KEY;
  process.env.RELAYER_SIGNER_PRIVATE_KEY = RELAYER_SIGNER_PRIVATE_KEY;
  process.env.NOTIFICATION_CALLBACK_URL = 'http://127.0.0.1:4100/webhook';
  process.env.HMAC_OUTBOUND_KEY_ID = 'outbound-v1';
  process.env.HMAC_OUTBOUND_KEY_SECRET = Buffer.alloc(32, 21).toString('base64url');
  process.env.RBF_THRESHOLD_MS = '1'; // irrelevant to whether an attempt is due; the pending-monitor
  // test backdates broadcastAt directly rather than waiting on this.
}

async function isNodeReachable(): Promise<boolean> {
  try {
    const response = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function insertOperation(
  operationRepository: OperationRepository,
  tokenId: number,
  toAddress: string,
): Promise<string> {
  const { operation } = await operationRepository.createOrGet({
    idempotencyKey: randomUUID(),
    type: OperationType.MINT,
    requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
    tokenId,
    toAddress,
  });
  return operation.id;
}

describe('TASK-10 transaction submission (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let systemSigner: SystemSignerService;
  let nonceCoordinator: NonceCoordinator;
  let submission: TransactionSubmissionService;
  let operationRepository: OperationRepository;
  let mintInterface: Interface;
  let chainId: number;
  let skip = false;

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(
        'Skipping TASK-10 integration suite: no reachable hardhat node at ' +
          RPC_URL +
          ' (start one with `npm run node --workspace=@cube-nft/contracts` and deploy with ' +
          '`npx hardhat run scripts/deploy.ts --network localhost` from contracts/cube-nft).',
      );
      return;
    }

    setEnv();
    dataSource = createTestDataSource();
    await dataSource.initialize();

    appConfig = new AppConfigService();
    rpc = new RpcService(appConfig);
    systemSigner = new SystemSignerService(appConfig);
    nonceCoordinator = new NonceCoordinator(dataSource, rpc, appConfig);
    submission = new TransactionSubmissionService(
      dataSource,
      nonceCoordinator,
      rpc,
      systemSigner,
      appConfig,
      new OperationRepository(dataSource),
      new AuditWriter(dataSource.getRepository(AuditRecord), dataSource.getRepository(FailureRecord)),
    );
    operationRepository = new OperationRepository(dataSource);
    mintInterface = new Interface(appConfig.cubeNft.abi as never);
    chainId = appConfig.cubeNft.deployment.chainId;
  });

  afterAll(async () => {
    if (skip) {
      return;
    }
    await dataSource.destroy();
  });

  it('submits a mint transaction that lands on-chain with the reserved nonce', async () => {
    if (skip) return;

    const tokenId = await unmintedTokenId(RPC_URL, appConfig.cubeNft.deployment.proxyAddress);
    const recipient = Wallet.createRandom().address;
    const operationId = await insertOperation(operationRepository, tokenId, recipient);
    const data = mintInterface.encodeFunctionData('mintTo', [
      recipient,
      tokenId,
      `ipfs://test/${tokenId}.json`,
    ]);

    const result = await submission.submit({
      operationId,
      chainId,
      signerRole: 'mint',
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
    });

    expect(result.attemptNo).toBe(1);
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const receipt = await pollForReceipt(rpc, result.txHash);
    expect(receipt?.status).toBe(1);

    const attempt = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { id: result.attemptId } });
    expect(attempt.status).toBe(TransactionAttemptStatus.BROADCAST);
    expect(attempt.signerAddress.toLowerCase()).toBe(systemSigner.addressFor('mint').toLowerCase());

    const cube = new Interface(['function ownerOf(uint256) view returns (address)']);
    const ownerOfCallData = cube.encodeFunctionData('ownerOf', [tokenId]);
    const rawOwner = await rpc
      .getReadProvider()
      .call({ to: appConfig.cubeNft.deployment.proxyAddress, data: ownerOfCallData });
    const [owner] = cube.decodeFunctionResult('ownerOf', rawOwner);
    expect((owner as string).toLowerCase()).toBe(recipient.toLowerCase());
  }, 30000);

  it('reserves distinct, gapless nonces under real concurrency for the same signer', async () => {
    if (skip) return;

    const submissions = await Promise.all(
      Array.from({ length: 5 }, async () => {
        const tokenId = await unmintedTokenId(RPC_URL, appConfig.cubeNft.deployment.proxyAddress);
        const recipient = Wallet.createRandom().address;
        const operationId = await insertOperation(operationRepository, tokenId, recipient);
        const data = mintInterface.encodeFunctionData('mintTo', [
          recipient,
          tokenId,
          `ipfs://test/${tokenId}.json`,
        ]);
        return submission.submit({
          operationId,
          chainId,
          signerRole: 'mint',
          to: appConfig.cubeNft.deployment.proxyAddress,
          data,
        });
      }),
    );

    const attempts = await dataSource
      .getRepository(TransactionAttempt)
      .find({ where: { id: In(submissions.map((s) => s.attemptId)) } });
    const nonces = new Set(attempts.map((a) => a.transactionNonce));
    expect(nonces.size).toBe(5);

    // Reservation order is DB-serialized (guaranteed gapless/unique, asserted above), but the
    // actual `broadcastTransaction` network calls that follow each reservation are not — two
    // submissions racing this closely can reach Hardhat out of nonce order, and Hardhat (unlike a
    // production mempool, which queues) rejects a higher nonce arriving before its predecessor
    // while automining. `TransactionSubmissionService` already handles this by design: a rejected
    // broadcast just leaves that attempt at SIGNED for `SignedAttemptRecoveryWorker` to retry — so
    // exercise that real recovery path here instead of asserting every one of the 5 raced its way
    // to a first-try broadcast.
    const recoveryWorker = new SignedAttemptRecoveryWorker(dataSource, submission, appConfig);
    await (recoveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    for (const s of submissions) {
      const receipt = await pollForReceipt(rpc, s.txHash);
      expect(receipt?.status).toBe(1);
    }
  }, 60000);

  it('SignedAttemptRecoveryWorker re-broadcasts an attempt that never made it off SIGNED', async () => {
    if (skip) return;

    const tokenId = await unmintedTokenId(RPC_URL, appConfig.cubeNft.deployment.proxyAddress);
    const recipient = Wallet.createRandom().address;
    const operationId = await insertOperation(operationRepository, tokenId, recipient);
    const data = mintInterface.encodeFunctionData('mintTo', [
      recipient,
      tokenId,
      `ipfs://test/${tokenId}.json`,
    ]);

    const signerAddress = systemSigner.addressFor('mint');
    const wallet = systemSigner.walletFor('mint');
    const nonce = await nonceCoordinator.reserveNext(chainId, signerAddress, randomUUID());
    const fee = await rpc.getFeeData();
    const gasLimit = await rpc.estimateGas({
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
      from: signerAddress,
    });
    const signedRawTransaction = await wallet.signTransaction({
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
      value: 0n,
      nonce: Number(nonce),
      chainId,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      gasLimit,
      type: 2,
    });

    const txHash = Transaction.from(signedRawTransaction).hash;
    if (!txHash) {
      throw new Error('Signed transaction did not produce a hash');
    }

    const attemptId = randomUUID();
    await dataSource.getRepository(TransactionAttempt).insert({
      id: attemptId,
      operationId,
      attemptNo: 1,
      chainId,
      signerAddress,
      transactionNonce: nonce,
      txHash,
      status: TransactionAttemptStatus.SIGNED,
      maxFeePerGasWei: fee.maxFeePerGas.toString(),
      maxPriorityFeePerGasWei: fee.maxPriorityFeePerGas.toString(),
      rawTransactionCiphertext: encryptRawTransaction(
        appConfig.submission.rawTxEncryptionKey,
        signedRawTransaction,
      ),
      rawTransactionPurgedAt: null,
      replacesAttemptId: null,
    });

    const recoveryWorker = new SignedAttemptRecoveryWorker(dataSource, submission, appConfig);
    await (recoveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const attempt = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { id: attemptId } });
    expect(attempt.status).toBe(TransactionAttemptStatus.BROADCAST);
  }, 30000);

  it('PendingMonitorWorker replaces a stale unconfirmed attempt with a higher-fee attempt at the same nonce', async () => {
    if (skip) return;

    await rpc.getReadProvider().send('evm_setAutomine', [false]);
    try {
      const tokenId = await unmintedTokenId(RPC_URL, appConfig.cubeNft.deployment.proxyAddress);
      const recipient = Wallet.createRandom().address;
      const operationId = await insertOperation(operationRepository, tokenId, recipient);
      await operationRepository.transition(
        operationId,
        OperationStatus.REQUESTED,
        OperationStatus.SUBMITTED,
        'test-setup',
      );
      const data = mintInterface.encodeFunctionData('mintTo', [
        recipient,
        tokenId,
        `ipfs://test/${tokenId}.json`,
      ]);

      const result = await submission.submit({
        operationId,
        chainId,
        signerRole: 'mint',
        to: appConfig.cubeNft.deployment.proxyAddress,
        data,
      });

      // Backdate broadcastAt so the pending monitor considers it stale, regardless of the
      // configured RBF threshold.
      await dataSource
        .createQueryBuilder()
        .update(TransactionAttempt)
        .set({ broadcastAt: () => 'DATE_SUB(NOW(3), INTERVAL 1 HOUR)' })
        .where('id = :id', { id: result.attemptId })
        .execute();

      const auditWriter = new AuditWriter(
        dataSource.getRepository(AuditRecord),
        dataSource.getRepository(FailureRecord),
      );
      const pendingMonitor = new PendingMonitorWorker(
        dataSource,
        rpc,
        submission,
        systemSigner,
        operationRepository,
        appConfig,
        auditWriter,
      );
      await (pendingMonitor as unknown as { runOnce(): Promise<void> }).runOnce();

      const attempts = await dataSource
        .getRepository(TransactionAttempt)
        .find({ where: { operationId }, order: { attemptNo: 'ASC' } });
      expect(attempts).toHaveLength(2);
      expect(attempts[1]?.replacesAttemptId).toBe(result.attemptId);
      expect(BigInt(attempts[1]?.maxFeePerGasWei ?? '0')).toBeGreaterThan(
        BigInt(attempts[0]?.maxFeePerGasWei ?? '0'),
      );
      expect(attempts[1]?.transactionNonce).toBe(attempts[0]?.transactionNonce);
    } finally {
      await rpc.getReadProvider().send('evm_setAutomine', [true]);
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }, 30000);
});

async function pollForReceipt(
  rpc: RpcService,
  txHash: string,
  timeoutMs = 15000,
): Promise<{ status: number | null } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await rpc.getTransactionReceipt(txHash);
    if (receipt) {
      return receipt;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}
