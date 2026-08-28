import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface, Wallet } from 'ethers';
import { In, type DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { TransactionAttemptStatus } from '../../src/shared/domain/transaction-attempt-status.enum';
import type {
  ReentryApprovalClaims,
  TransferApprovalClaims,
} from '../../src/shared/auth/approval-jwt/approval-jwt-claims';
import { ApiError } from '../../src/shared/http/api-error';
import { OperationIntakeService } from '../../src/shared/idempotency/operation-intake.service';
import { AuditWriter } from '../../src/domains/audit/application/audit-writer';
import { AuditRecord } from '../../src/domains/audit/persistence/audit-record.entity';
import { FailureCode, FailureRecord } from '../../src/domains/audit/persistence/failure-record.entity';
import { TransferApplication } from '../../src/domains/nft/transfer/transfer.application';
import { TransferWorker } from '../../src/domains/nft/transfer/transfer.worker';
import { ReentryApplication } from '../../src/domains/nft/reentry/reentry.application';
import { ReentryWorker } from '../../src/domains/nft/reentry/reentry.worker';
import { NotificationDelivery } from '../../src/domains/notification/persistence/notification-delivery.entity';
import { NotificationOutboxRepository } from '../../src/domains/notification/persistence/notification-outbox.repository';
import { OperationFinalizer } from '../../src/domains/operation/finalizer/operation-finalizer.service';
import { Operation } from '../../src/domains/operation/persistence/operation.entity';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { ConfirmationService } from '../../src/domains/transaction/confirmation/confirmation.service';
import {
  NonceCoordinator,
  SignerHaltedError,
} from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { ApprovalJtiBindingRepository } from '../../src/domains/transaction/persistence/approval-jti-binding.repository';
import { AssetLock, AssetLockStatus } from '../../src/domains/transaction/persistence/asset-lock.entity';
import { AssetLockRepository } from '../../src/domains/transaction/persistence/asset-lock.repository';
import { SignerLock } from '../../src/domains/transaction/persistence/signer-lock.entity';
import {
  SignerNonceReservation,
  SignerNonceReservationStatus,
} from '../../src/domains/transaction/persistence/signer-nonce-reservation.entity';
import { TransactionAttempt } from '../../src/domains/transaction/persistence/transaction-attempt.entity';
import { ConsentDryRunService } from '../../src/domains/transaction/rpc/consent-dry-run.service';
import { CubeNftReaderService } from '../../src/domains/transaction/rpc/cube-nft-reader.service';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import {
  encodeAuthorizedTransfer,
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
  ownerConsentDomain,
} from '../../src/domains/transaction/signing/owner-consent';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { SignedAttemptRecoveryWorker } from '../../src/domains/transaction/submission/signed-attempt-recovery.worker';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { FakeWeb3AuthAdapter } from '../../src/domains/wallet/providers/fake-web3auth.adapter';
import { WalletService } from '../../src/domains/wallet/application/wallet.service';
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString('base64');

function setEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3100';
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
  process.env.CONFIRMATION_BLOCKS_REQUIRED = '5';
  process.env.BROADCAST_MAX_RETRIES = '3';
  process.env.NONCE_RESERVATION_LEASE_MS = '1000';
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

function randomTokenId(): number {
  return Math.floor(Math.random() * 9000) + 1;
}

function baseApprovalFields(tokenId: number) {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: randomUUID(),
    iss: 'arzone-backend',
    aud: 'arzone-blockchain-server',
    iat: now,
    exp: now + 300,
    tokenId,
  };
}

async function expectApiError(promise: Promise<unknown>, code: string, status?: number): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ApiError);
  expect((caught as ApiError).code).toBe(code);
  if (status !== undefined) {
    expect((caught as ApiError).getStatus()).toBe(status);
  }
}

/**
 * Regression coverage for the 2026-08-28 verification remediation (docs/검증-종합-문제-원인-개선안.md):
 * D1 nonce lifecycle, D2 transfer ownership, D3 accept-time consent dry-run, D4 UTC timestamps,
 * D6 ciphertext purge, D7 receipt evidence, D8 encrypted signature storage — all against a real
 * local Hardhat node and a real MySQL, like the other TASK integration suites.
 */
describe('verification remediation D1–D8 (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let cubeNftReader: CubeNftReaderService;
  let walletService: WalletService;
  let operationRepository: OperationRepository;
  let assetLockRepository: AssetLockRepository;
  let nonceCoordinator: NonceCoordinator;
  let systemSigner: SystemSignerService;
  let submission: TransactionSubmissionService;
  let auditWriter: AuditWriter;
  let operationIntake: OperationIntakeService;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let mintInterface: Interface;
  let chainId: number;
  let proxyAddress: string;
  let skip = false;

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

  /** Random tokenId that is not yet minted on the (possibly long-lived, shared) local chain. */
  async function unmintedTokenId(): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const candidate = randomTokenId();
      if ((await cubeNftReader.ownerOf(candidate)) === null) {
        return candidate;
      }
    }
    throw new Error('could not find an unminted tokenId');
  }

  async function mintDirect(recipient: string): Promise<{ tokenId: number; operationId: string }> {
    const tokenId = await unmintedTokenId();
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: recipient,
    });
    await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test',
    );
    const data = mintInterface.encodeFunctionData('mintTo', [
      recipient,
      tokenId,
      `ipfs://test/${tokenId}.json`,
    ]);
    await submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'mint',
      to: proxyAddress,
      data,
    });
    await mineBlocks(5);
    return { tokenId, operationId: operation.id };
  }

  async function withdrawDirect(
    custodialAddress: string,
    externalAddress: string,
    tokenId: number,
  ): Promise<void> {
    const ownerRows = await dataSource.query<{ user_id: string }[]>(
      'SELECT user_id FROM wallet_accounts WHERE address = ?',
      [custodialAddress],
    );
    const custodial = await walletService.findByUserId(ownerRows[0]!.user_id);
    const nonce = await cubeNftReader.consentNonce(tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const consent = {
      tokenId,
      currentOwner: custodialAddress,
      from: custodialAddress,
      to: externalAddress,
      purpose: OwnerConsentPurpose.WITHDRAWAL,
      nonce,
      deadline,
    };
    const signature = await walletService.signTypedData(
      custodial!.userId,
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      consent,
      OperationType.WITHDRAWAL,
    );
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.WITHDRAWAL,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      fromAddress: custodialAddress,
      toAddress: externalAddress,
    });
    await submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'relayer',
      to: proxyAddress,
      data: encodeAuthorizedTransfer(consent, signature),
    });
    await mineBlocks(1);
  }

  async function relayerReservations(): Promise<SignerNonceReservation[]> {
    return dataSource.getRepository(SignerNonceReservation).find({
      where: { chainId, signerAddress: systemSigner.addressFor('relayer') },
      order: { transactionNonce: 'ASC' },
    });
  }

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(`Skipping remediation integration suite: no reachable hardhat node at ${RPC_URL}.`);
      return;
    }
    setEnv();
    // The gap test relies on Hardhat's automine "Nonce too high" rejection; another suite may have
    // left automine off.
    await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'evm_setAutomine', params: [true], id: 1 }),
    });
    dataSource = createTestDataSource();
    await dataSource.initialize();

    appConfig = new AppConfigService();
    rpc = new RpcService(appConfig);
    cubeNftReader = new CubeNftReaderService(rpc, appConfig);
    walletService = new WalletService(new FakeWeb3AuthAdapter(), dataSource);
    operationRepository = new OperationRepository(dataSource);
    assetLockRepository = new AssetLockRepository(dataSource);
    nonceCoordinator = new NonceCoordinator(dataSource, rpc, appConfig);
    systemSigner = new SystemSignerService(appConfig);
    auditWriter = new AuditWriter(
      dataSource.getRepository(AuditRecord),
      dataSource.getRepository(FailureRecord),
    );
    submission = new TransactionSubmissionService(
      dataSource,
      nonceCoordinator,
      rpc,
      systemSigner,
      appConfig,
      operationRepository,
      auditWriter,
    );
    operationIntake = new OperationIntakeService(
      dataSource,
      operationRepository,
      new ApprovalJtiBindingRepository(dataSource),
      assetLockRepository,
    );
    confirmationService = new ConfirmationService(dataSource, rpc, appConfig);
    finalizer = new OperationFinalizer(
      dataSource,
      operationRepository,
      assetLockRepository,
      new NotificationOutboxRepository(dataSource),
    );
    mintInterface = new Interface(appConfig.cubeNft.abi as never);
    chainId = appConfig.cubeNft.deployment.chainId;
    proxyAddress = appConfig.cubeNft.deployment.proxyAddress;
  });

  afterAll(async () => {
    if (skip) return;
    // Never leave a signer halted for the other suites.
    await nonceCoordinator.clearHalt(chainId, systemSigner.addressFor('relayer'));
    await nonceCoordinator.clearHalt(chainId, systemSigner.addressFor('mint'));
    await dataSource.destroy();
  });

  // ---------------------------------------------------------------------------------------------
  // D1 — nonce lifecycle
  // ---------------------------------------------------------------------------------------------

  it('D1: a deterministic estimateGas revert leaves no nonce reservation behind', async () => {
    if (skip) return;
    const before = await relayerReservations();
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.REENTRY,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId: randomTokenId(),
    });
    // Scratch Operation: park it so no worker ever picks it up.
    await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.CANCELLED,
      'test',
    );
    // authorizedTransfer with a garbage consent reverts at estimateGas (InvalidOwnerConsentSignature /
    // ERC721NonexistentToken) — exactly the D1 trigger observed in verification.
    const consent = {
      tokenId: operation.tokenId,
      currentOwner: Wallet.createRandom().address,
      from: Wallet.createRandom().address,
      to: Wallet.createRandom().address,
      purpose: OwnerConsentPurpose.REENTRY,
      nonce: 0n,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    };
    const data = encodeAuthorizedTransfer(consent, `0x${'11'.repeat(65)}`);
    await expect(
      submission.submit({
        operationId: operation.id,
        chainId,
        signerRole: 'relayer',
        to: proxyAddress,
        data,
      }),
    ).rejects.toBeDefined();
    const after = await relayerReservations();
    expect(after.length).toBe(before.length);
    expect(
      await dataSource.getRepository(TransactionAttempt).count({ where: { operationId: operation.id } }),
    ).toBe(0);
  }, 30000);

  it('D1: a fee-data RPC failure before reservation leaves no nonce reservation behind', async () => {
    if (skip) return;
    const before = await relayerReservations();
    const spy = jest.spyOn(rpc, 'getFeeData').mockRejectedValueOnce(new Error('simulated fee RPC outage'));
    try {
      const { operation } = await operationRepository.createOrGet({
        idempotencyKey: randomUUID(),
        type: OperationType.MINT,
        requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
        tokenId: randomTokenId(),
      });
      await operationRepository.transition(
        operation.id,
        OperationStatus.REQUESTED,
        OperationStatus.CANCELLED,
        'test',
      );
      const data = mintInterface.encodeFunctionData('mintTo', [
        Wallet.createRandom().address,
        operation.tokenId,
        'ipfs://x',
      ]);
      await expect(
        submission.submit({
          operationId: operation.id,
          chainId,
          signerRole: 'relayer',
          to: proxyAddress,
          data,
        }),
      ).rejects.toThrow('simulated fee RPC outage');
    } finally {
      spy.mockRestore();
    }
    expect((await relayerReservations()).length).toBe(before.length);
  }, 30000);

  it('D1: a failure after reservation but before the SIGNED commit releases the nonce, and the next submission re-uses it', async () => {
    if (skip) return;
    const signerAddress = systemSigner.addressFor('mint');
    const wallet = systemSigner.walletFor('mint');
    // Simulate "signing failed after reserving".
    const signSpy = jest
      .spyOn(wallet, 'signTransaction')
      .mockRejectedValueOnce(new Error('simulated signer failure'));
    const tokenA = await unmintedTokenId();
    const recipient = Wallet.createRandom().address;
    const { operation: opA } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId: tokenA,
      toAddress: recipient,
    });
    await operationRepository.transition(
      opA.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test',
    );
    const dataA = mintInterface.encodeFunctionData('mintTo', [recipient, tokenA, 'ipfs://a']);
    try {
      await expect(
        submission.submit({
          operationId: opA.id,
          chainId,
          signerRole: 'mint',
          to: proxyAddress,
          data: dataA,
        }),
      ).rejects.toThrow('simulated signer failure');
    } finally {
      signSpy.mockRestore();
    }
    const released = await dataSource.getRepository(SignerNonceReservation).findOne({
      where: { chainId, signerAddress, status: SignerNonceReservationStatus.RELEASED },
      order: { transactionNonce: 'DESC' },
    });
    expect(released).not.toBeNull();

    // Next submission for the same signer must take exactly that released nonce (gap fill) and land.
    const tokenB = await unmintedTokenId();
    const { operation: opB } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId: tokenB,
      toAddress: recipient,
    });
    await operationRepository.transition(
      opB.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test',
    );
    const dataB = mintInterface.encodeFunctionData('mintTo', [recipient, tokenB, 'ipfs://b']);
    const result = await submission.submit({
      operationId: opB.id,
      chainId,
      signerRole: 'mint',
      to: proxyAddress,
      data: dataB,
    });
    const attempt = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { id: result.attemptId } });
    expect(attempt.transactionNonce).toBe(released!.transactionNonce);
    expect(attempt.status).toBe(TransactionAttemptStatus.BROADCAST);
    const reused = await dataSource
      .getRepository(SignerNonceReservation)
      .findOneOrFail({ where: { id: released!.id } });
    expect(reused.status).toBe(SignerNonceReservationStatus.ACTIVE);
    expect(reused.attemptId).toBe(result.attemptId);
  }, 30000);

  it('D1: a nonce gap opens the signer circuit breaker (SIGNER_NONCE_GAP), refuses new MAX+1 reservations, and recovery resumes once the gap is filled', async () => {
    if (skip) return;
    const signerAddress = systemSigner.addressFor('mint');
    const wallet = systemSigner.walletFor('mint');
    // Manufacture a gap the way the verification did: reserve a nonce that never gets broadcast.
    const gapAttemptId = randomUUID();
    const gapNonce = await nonceCoordinator.reserveNext(chainId, signerAddress, gapAttemptId);
    const recipient = Wallet.createRandom().address;

    // Next real submission signs nonce+1 → broadcast fails with "Nonce too high" → SIGNED + halt.
    const tokenId = await unmintedTokenId();
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: recipient,
    });
    await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test',
    );
    const data = mintInterface.encodeFunctionData('mintTo', [recipient, tokenId, 'ipfs://gap']);
    const result = await submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'mint',
      to: proxyAddress,
      data,
    });
    const stuck = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { id: result.attemptId } });
    expect(stuck.status).toBe(TransactionAttemptStatus.SIGNED);
    expect(BigInt(stuck.transactionNonce)).toBe(BigInt(gapNonce) + 1n);
    expect(stuck.lastBroadcastError).toContain('NONCE_TOO_HIGH');
    expect(stuck.nextBroadcastAt).not.toBeNull();
    expect(stuck.broadcastAttemptCount).toBe(1);

    const lock = await dataSource
      .getRepository(SignerLock)
      .findOneOrFail({ where: { chainId, signerAddress } });
    expect(lock.haltedReason).toBe('NONCE_GAP');
    const gapRecord = await dataSource.getRepository(FailureRecord).findOne({
      where: { code: FailureCode.SIGNER_NONCE_GAP, operationId: operation.id },
    });
    expect(gapRecord).not.toBeNull();

    // While halted and the gap reservation is still ACTIVE (lease not expired, no attempt), a fresh
    // MAX+1 reservation is refused.
    await expect(nonceCoordinator.reserveNext(chainId, signerAddress, randomUUID())).rejects.toBeInstanceOf(
      SignerHaltedError,
    );

    // Operator/automatic gap fill: release the orphaned reservation, then the next reserveNext hands
    // out exactly the gap nonce even though the signer is halted.
    expect(await nonceCoordinator.releaseUnused(chainId, signerAddress, gapNonce, gapAttemptId)).toBe(true);
    const fillerAttemptId = randomUUID();
    const filledNonce = await nonceCoordinator.reserveNext(chainId, signerAddress, fillerAttemptId);
    expect(filledNonce).toBe(gapNonce);
    // Land a filler at that nonce (what a real submission or `fill-nonce-gap` does).
    const fee = await rpc.getFeeData();
    const raw = await wallet.signTransaction({
      to: signerAddress,
      value: 0n,
      data: '0x',
      nonce: Number(filledNonce),
      chainId,
      gasLimit: 21000n,
      maxFeePerGas: fee.maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      type: 2,
    });
    await rpc.broadcastTransaction(raw);
    // Keep the coordinator's bookkeeping honest: the filler is a committed use of that nonce.
    await dataSource.getRepository(TransactionAttempt).insert({
      id: fillerAttemptId,
      operationId: operation.id,
      attemptNo: 99,
      chainId,
      signerAddress,
      transactionNonce: filledNonce,
      txHash: `0x${randomUUID().replace(/-/g, '')}${randomUUID().replace(/-/g, '')}`,
      status: TransactionAttemptStatus.SUPERSEDED,
      rawTransactionCiphertext: null,
      rawTransactionPurgedAt: new Date(),
      broadcastAttemptCount: 1,
    });

    // Recovery: force the backoff to elapse, run the worker — the stuck attempt broadcasts and the
    // halt clears, same txHash as originally signed.
    await dataSource
      .createQueryBuilder()
      .update(TransactionAttempt)
      .set({ nextBroadcastAt: () => 'DATE_SUB(NOW(3), INTERVAL 1 SECOND)' })
      .where('id = :id', { id: stuck.id })
      .execute();
    const recovery = new SignedAttemptRecoveryWorker(dataSource, submission, appConfig);
    await (recovery as unknown as { runOnce(): Promise<void> }).runOnce();
    const recovered = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { id: stuck.id } });
    expect(recovered.status).toBe(TransactionAttemptStatus.BROADCAST);
    expect(recovered.txHash).toBe(stuck.txHash);
    const lockAfter = await dataSource
      .getRepository(SignerLock)
      .findOneOrFail({ where: { chainId, signerAddress } });
    expect(lockAfter.haltedReason).toBeNull();
  }, 60000);

  it('D1: a permanent broadcast reject escalates the attempt and Operation to REVIEW_REQUIRED with a BROADCAST_RETRY_EXHAUSTED record', async () => {
    if (skip) return;
    const recipient = Wallet.createRandom().address;
    const tokenId = await unmintedTokenId();
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: recipient,
    });
    await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test',
    );
    const data = mintInterface.encodeFunctionData('mintTo', [recipient, tokenId, 'ipfs://permanent']);
    const spy = jest.spyOn(rpc, 'broadcastTransaction').mockRejectedValueOnce(
      Object.assign(new Error('insufficient funds for gas * price + value'), {
        code: 'INSUFFICIENT_FUNDS',
      }),
    );
    try {
      const result = await submission.submit({
        operationId: operation.id,
        chainId,
        signerRole: 'mint',
        to: proxyAddress,
        data,
      });
      const attempt = await dataSource
        .getRepository(TransactionAttempt)
        .findOneOrFail({ where: { id: result.attemptId } });
      expect(attempt.status).toBe(TransactionAttemptStatus.REVIEW_REQUIRED);
      expect(attempt.lastBroadcastError).toContain('INSUFFICIENT_FUNDS');
      const op = await operationRepository.findById(operation.id);
      expect(op?.status).toBe(OperationStatus.REVIEW_REQUIRED);
      expect(op?.reviewReason).toBe('BROADCAST_REJECTED');
      const record = await dataSource.getRepository(FailureRecord).findOne({
        where: { code: FailureCode.BROADCAST_RETRY_EXHAUSTED, operationId: operation.id },
      });
      expect(record).not.toBeNull();
      expect(JSON.stringify(record?.details)).not.toMatch(/0x[0-9a-fA-F]{67,}/u);
    } finally {
      spy.mockRestore();
      // The orphaned nonce of this attempt must not block the mint signer for later tests.
      const attempt = await dataSource
        .getRepository(TransactionAttempt)
        .findOne({ where: { operationId: operation.id } });
      if (attempt) {
        const fee = await rpc.getFeeData();
        const raw = await systemSigner.walletFor('mint').signTransaction({
          to: systemSigner.addressFor('mint'),
          value: 0n,
          data: '0x',
          nonce: Number(attempt.transactionNonce),
          chainId,
          gasLimit: 21000n,
          maxFeePerGas: fee.maxFeePerGas,
          maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
          type: 2,
        });
        await rpc.broadcastTransaction(raw).catch(() => undefined);
      }
    }
  }, 30000);

  // ---------------------------------------------------------------------------------------------
  // D2 — transfer ownership
  // ---------------------------------------------------------------------------------------------

  it('D2: a Transfer whose claimed seller does not own the token is rejected even when the buyer holds it, and no Operation/lock is created', async () => {
    if (skip) return;
    const sellerUserId = `seller-${randomUUID()}`;
    const buyerUserId = `buyer-${randomUUID()}`;
    const seller = await walletService.getOrCreate(sellerUserId);
    const buyer = await walletService.getOrCreate(buyerUserId);
    // The token is minted straight to the *buyer* — the verification's T08-04 scenario.
    const { tokenId } = await mintDirect(buyer.address);
    const transferApplication = new TransferApplication(
      walletService,
      operationIntake,
      cubeNftReader,
      operationRepository,
    );
    const tradeId = `trade-${randomUUID()}`;
    const approval: TransferApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.TRANSFER,
      tradeId,
      sellerUserId,
      buyerUserId,
      from: seller.address,
      to: buyer.address,
    };
    const operationsBefore = await dataSource.getRepository(Operation).count({ where: { tokenId } });
    await expectApiError(
      transferApplication.accept(
        { idempotencyKey: randomUUID(), tradeId, sellerUserId, buyerUserId, tokenId },
        approval,
      ),
      'TRANSFER_OWNER_MISMATCH',
      409,
    );
    expect(await dataSource.getRepository(Operation).count({ where: { tokenId } })).toBe(operationsBefore);
    expect(
      await dataSource.getRepository(AssetLock).count({ where: { tokenId, status: AssetLockStatus.ACTIVE } }),
    ).toBe(0);
  }, 60000);

  it('D2: the worker never marks a tx-less Operation ONCHAIN_CONFIRMED — token already at destination → REVIEW_REQUIRED with a reason', async () => {
    if (skip) return;
    const sellerUserId = `seller-${randomUUID()}`;
    const buyerUserId = `buyer-${randomUUID()}`;
    const seller = await walletService.getOrCreate(sellerUserId);
    const buyer = await walletService.getOrCreate(buyerUserId);
    const { tokenId } = await mintDirect(buyer.address);
    // Bypass accept-time checks to plant a REQUESTED transfer whose token is already with the buyer.
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.TRANSFER,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      fromAddress: seller.address,
      toAddress: buyer.address,
      metadata: { tradeId: `trade-${randomUUID()}` },
    });
    const worker = new TransferWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      walletService,
      submission,
      appConfig,
      auditWriter,
    );
    await (worker as unknown as { runOnce(): Promise<void> }).runOnce();
    const after = await operationRepository.findById(operation.id);
    expect(after?.status).toBe(OperationStatus.REVIEW_REQUIRED);
    expect(after?.reviewReason).toBe('OWNER_ALREADY_AT_DESTINATION');
    expect(
      await dataSource.getRepository(TransactionAttempt).count({ where: { operationId: operation.id } }),
    ).toBe(0);
    expect(
      await dataSource.getRepository(NotificationDelivery).count({ where: { operationId: operation.id } }),
    ).toBe(0);
  }, 60000);

  // ---------------------------------------------------------------------------------------------
  // D3 / D8 — external consent dry-run and encrypted storage
  // ---------------------------------------------------------------------------------------------

  it('D3: an externally-signed consent from the wrong key is rejected at accept-time (403) with no Operation and no lock', async () => {
    if (skip) return;
    const userId = `user-${randomUUID()}`;
    const custodial = await walletService.getOrCreate(userId);
    const external = Wallet.createRandom();
    const impostor = Wallet.createRandom();
    const { tokenId } = await mintDirect(custodial.address);
    await withdrawDirect(custodial.address, external.address, tokenId);
    expect((await cubeNftReader.ownerOf(tokenId))?.toLowerCase()).toBe(external.address.toLowerCase());

    const nonce = await cubeNftReader.consentNonce(tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const message = {
      tokenId,
      currentOwner: external.address,
      from: external.address,
      to: custodial.address,
      purpose: OwnerConsentPurpose.REENTRY,
      nonce,
      deadline,
    };
    const wrongSignature = await impostor.signTypedData(
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      message,
    );
    const reentry = new ReentryApplication(
      walletService,
      operationIntake,
      cubeNftReader,
      appConfig,
      new ConsentDryRunService(rpc, appConfig),
    );
    const approval: ReentryApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.REENTRY,
      userId,
      from: external.address,
      to: custodial.address,
    };
    const before = await dataSource.getRepository(Operation).count({ where: { tokenId } });
    await expectApiError(
      reentry.accept(
        {
          idempotencyKey: randomUUID(),
          userId,
          tokenId,
          externalAddress: external.address,
          consentNonce: nonce.toString(),
          consentDeadline: deadline.toString(),
          externalSignature: wrongSignature,
        },
        approval,
      ),
      'CONSENT_SIGNATURE_INVALID',
      403,
    );
    expect(await dataSource.getRepository(Operation).count({ where: { tokenId } })).toBe(before);
    expect(
      await dataSource.getRepository(AssetLock).count({ where: { tokenId, status: AssetLockStatus.ACTIVE } }),
    ).toBe(0);

    // A stale nonce with the *right* signer is also caught before any row exists.
    const staleMessage = { ...message, nonce: nonce + 5n };
    const staleSignature = await external.signTypedData(
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      staleMessage,
    );
    await expectApiError(
      reentry.accept(
        {
          idempotencyKey: randomUUID(),
          userId,
          tokenId,
          externalAddress: external.address,
          consentNonce: (nonce + 5n).toString(),
          consentDeadline: deadline.toString(),
          externalSignature: staleSignature,
        },
        { ...approval, jti: randomUUID() },
      ),
      'CONSENT_NONCE_INVALID',
      409,
    );

    // The correct signature passes the dry-run, is stored encrypted (D8), and the worker purges it
    // after committing the SIGNED attempt.
    const goodSignature = await external.signTypedData(
      ownerConsentDomain(chainId, proxyAddress),
      OWNER_CONSENT_TYPES,
      message,
    );
    const { operation } = await reentry.accept(
      {
        idempotencyKey: randomUUID(),
        userId,
        tokenId,
        externalAddress: external.address,
        consentNonce: nonce.toString(),
        consentDeadline: deadline.toString(),
        externalSignature: goodSignature,
      },
      { ...approval, jti: randomUUID() },
    );
    const stored = (await operationRepository.findById(operation.id))?.metadata ?? {};
    expect(JSON.stringify(stored)).not.toContain(goodSignature.slice(2));
    expect(typeof stored.externalSignatureCiphertext).toBe('string');
    expect(typeof stored.externalSignatureHash).toBe('string');

    const worker = new ReentryWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      submission,
      appConfig,
      auditWriter,
    );
    await (worker as unknown as { runOnce(): Promise<void> }).runOnce();
    const submitted = await operationRepository.findById(operation.id);
    expect(submitted?.status).toBe(OperationStatus.SUBMITTED);
    expect(submitted?.metadata?.externalSignatureCiphertext).toBeNull();
    await mineBlocks(5);
    const result = await confirmationService.evaluate(submitted!);
    await finalizer.apply(submitted!, result);
    expect((await operationRepository.findById(operation.id))?.status).toBe(
      OperationStatus.ONCHAIN_CONFIRMED,
    );
    expect((await cubeNftReader.ownerOf(tokenId))?.toLowerCase()).toBe(custodial.address.toLowerCase());
  }, 90000);

  it('D3: a consent dry-run that cannot reach the chain is a retryable 503, never an acceptance', async () => {
    if (skip) return;
    const dryRun = new ConsentDryRunService(rpc, appConfig);
    const spy = jest
      .spyOn(rpc, 'simulateCall')
      .mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' }));
    try {
      await expectApiError(
        dryRun.verifyAuthorizedTransfer(
          {
            tokenId: 1,
            currentOwner: Wallet.createRandom().address,
            from: Wallet.createRandom().address,
            to: Wallet.createRandom().address,
            purpose: OwnerConsentPurpose.REENTRY,
            nonce: 0n,
            deadline: 1n,
          },
          `0x${'22'.repeat(65)}`,
        ),
        'CONSENT_VERIFICATION_UNAVAILABLE',
        503,
      );
    } finally {
      spy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------------------------
  // D4 / D6 / D7 — UTC timestamps, ciphertext purge, receipt evidence
  // ---------------------------------------------------------------------------------------------

  it('D4/D6/D7: a confirmed mint records receipt evidence, purges the raw transaction, and reports UTC timestamps that agree with the DB clock', async () => {
    if (skip) return;
    const recipient = Wallet.createRandom().address;
    const { tokenId, operationId } = await mintDirect(recipient);
    const operation = await operationRepository.findById(operationId);
    const result = await confirmationService.evaluate(operation!);
    expect(result.outcome).toBe('CONFIRMED');
    await finalizer.apply(operation!, result);

    const attempt = await dataSource
      .getRepository(TransactionAttempt)
      .findOneOrFail({ where: { operationId } });
    expect(attempt.status).toBe(TransactionAttemptStatus.CONFIRMED);
    expect(attempt.receiptBlockNumber).not.toBeNull();
    expect(attempt.receiptBlockHash).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(attempt.receiptStatus).toBe(1);
    expect(attempt.confirmedAt).not.toBeNull();
    expect(attempt.confirmationCount).toBeGreaterThanOrEqual(5);
    // D6
    expect(attempt.rawTransactionCiphertext).toBeNull();
    expect(attempt.rawTransactionPurgedAt).not.toBeNull();

    // D4: the JS Date read back through TypeORM must equal the DB's own UTC clock reading of the
    // same column (no host-timezone shift), and be within a minute of "now".
    const rows = await dataSource.query<{ epoch: string; db_now: string }[]>(
      'SELECT UNIX_TIMESTAMP(created_at) AS epoch, UNIX_TIMESTAMP(UTC_TIMESTAMP(3)) AS db_now FROM operations WHERE id = ?',
      [operationId],
    );
    const dbEpochMs = Number(rows[0]!.epoch) * 1000;
    const fresh = await operationRepository.findById(operationId);
    expect(Math.abs(fresh!.createdAt.getTime() - dbEpochMs)).toBeLessThan(1500);
    expect(Math.abs(Date.now() - fresh!.createdAt.getTime())).toBeLessThan(60_000);
    // and, by construction, no LONG_PENDING false positive can be computed from it:
    expect(Date.now() - fresh!.updatedAt.getTime()).toBeLessThan(appConfig.audit.longPendingThresholdMs);

    // Webhook payload matches the documented BlockchainEvent shape.
    const delivery: NotificationDelivery = await dataSource
      .getRepository(NotificationDelivery)
      .findOneOrFail({ where: { operationId } });
    expect(delivery.payload).toMatchObject({
      operationType: OperationType.MINT,
      finalStatus: 'ONCHAIN_CONFIRMED',
      finalOwnerAddress: expect.any(String) as unknown,
      txHash: attempt.txHash,
      blockNumber: Number(attempt.receiptBlockNumber),
      blockHash: attempt.receiptBlockHash,
      serviceRightsState: null,
    });
    expect((delivery.payload as { confirmations: number }).confirmations).toBeGreaterThanOrEqual(5);
    expect(tokenId).toBeGreaterThan(0);
  }, 60000);

  it('D3: transition() persists reviewReason and clears it when leaving REVIEW_REQUIRED', async () => {
    if (skip) return;
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId: randomTokenId(),
    });
    const reviewed = await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.REVIEW_REQUIRED,
      'CONSENT_REJECTED_ON_SUBMIT',
    );
    expect(reviewed.reviewReason).toBe('CONSENT_REJECTED_ON_SUBMIT');
    const failed = await operationRepository.transition(
      operation.id,
      OperationStatus.REVIEW_REQUIRED,
      OperationStatus.FAILED,
      'OPERATOR_RELEASE_LOCK',
    );
    expect(failed.reviewReason).toBeNull();
    expect(failed.failureCode).toBe('OPERATOR_RELEASE_LOCK');
    expect(
      await dataSource.getRepository(Operation).count({
        where: { id: operation.id, status: In([OperationStatus.FAILED]) },
      }),
    ).toBe(1);
  });
});
