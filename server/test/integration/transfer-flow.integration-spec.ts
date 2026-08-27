import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface } from 'ethers';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import type { TransferApprovalClaims } from '../../src/shared/auth/approval-jwt/approval-jwt-claims';
import { ApiError } from '../../src/shared/http/api-error';
import { OperationIntakeService } from '../../src/shared/idempotency/operation-intake.service';
import { ConfirmationService } from '../../src/domains/transaction/confirmation/confirmation.service';
import { NonceCoordinator } from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { ApprovalJtiBindingRepository } from '../../src/domains/transaction/persistence/approval-jti-binding.repository';
import { AssetLockRepository } from '../../src/domains/transaction/persistence/asset-lock.repository';
import { NotificationOutboxRepository } from '../../src/domains/notification/persistence/notification-outbox.repository';
import { CubeNftReaderService } from '../../src/domains/transaction/rpc/cube-nft-reader.service';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { OperationFinalizer } from '../../src/domains/operation/finalizer/operation-finalizer.service';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { FakeWeb3AuthAdapter } from '../../src/domains/wallet/providers/fake-web3auth.adapter';
import { WalletService } from '../../src/domains/wallet/application/wallet.service';
import { AuditWriter } from '../../src/domains/audit/application/audit-writer';
import { AuditRecord } from '../../src/domains/audit/persistence/audit-record.entity';
import { FailureRecord } from '../../src/domains/audit/persistence/failure-record.entity';
import { TransferApplication } from '../../src/domains/nft/transfer/transfer.application';
import { TransferWorker } from '../../src/domains/nft/transfer/transfer.worker';
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 13).toString('base64');

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
  process.env.CONFIRMATION_BLOCKS_REQUIRED = '5';
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

function transferApproval(
  overrides: Partial<TransferApprovalClaims> & {
    tokenId: number;
    tradeId: string;
    sellerUserId: string;
    buyerUserId: string;
    from: string;
    to: string;
  },
): TransferApprovalClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: randomUUID(),
    iss: 'arzone-backend',
    aud: 'arzone-blockchain-server',
    iat: now,
    exp: now + 300,
    purpose: OperationType.TRANSFER,
    ...overrides,
  };
}

describe('TASK-08 transfer flow end-to-end (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let cubeNftReader: CubeNftReaderService;
  let walletService: WalletService;
  let transferApplication: TransferApplication;
  let transferWorker: TransferWorker;
  let operationRepository: OperationRepository;
  let assetLockRepository: AssetLockRepository;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let mintInterface: Interface;
  let submission: TransactionSubmissionService;
  let chainId: number;
  let skip = false;

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

  /** Mints a fresh token directly (bypassing TASK-07's HTTP flow, which isn't the thing under
   * test here) and confirms it, so each transfer test starts from a real, owned token. */
  async function mintAndConfirm(recipientAddress: string): Promise<number> {
    const tokenId = randomTokenId();
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: recipientAddress,
    });
    const data = mintInterface.encodeFunctionData('mintTo', [
      recipientAddress,
      tokenId,
      `ipfs://test/${tokenId}.json`,
    ]);
    await submission.submit({
      operationId: operation.id,
      chainId,
      signerRole: 'mint',
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
    });
    await mineBlocks(5);
    return tokenId;
  }

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(
        `Skipping TASK-08 transfer flow integration suite: no reachable hardhat node at ${RPC_URL}.`,
      );
      return;
    }

    setEnv();
    dataSource = createTestDataSource();
    await dataSource.initialize();

    appConfig = new AppConfigService();
    rpc = new RpcService(appConfig);
    cubeNftReader = new CubeNftReaderService(rpc, appConfig);
    walletService = new WalletService(new FakeWeb3AuthAdapter(), dataSource);

    const operationIntake = new OperationIntakeService(
      dataSource,
      new OperationRepository(dataSource),
      new ApprovalJtiBindingRepository(dataSource),
      new AssetLockRepository(dataSource),
    );
    transferApplication = new TransferApplication(walletService, operationIntake, cubeNftReader);

    const nonceCoordinator = new NonceCoordinator(dataSource, rpc);
    const systemSigner = new SystemSignerService(appConfig);
    submission = new TransactionSubmissionService(dataSource, nonceCoordinator, rpc, systemSigner, appConfig);
    operationRepository = new OperationRepository(dataSource);
    assetLockRepository = new AssetLockRepository(dataSource);
    const auditWriter = new AuditWriter(
      dataSource.getRepository(AuditRecord),
      dataSource.getRepository(FailureRecord),
    );
    transferWorker = new TransferWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      walletService,
      submission,
      appConfig,
      auditWriter,
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
  });

  afterAll(async () => {
    if (skip) return;
    await dataSource.destroy();
  });

  it('accept -> worker signs OwnerConsent and submits -> reconciliation confirms, end to end', async () => {
    if (skip) return;

    const sellerUserId = `user-${randomUUID()}`;
    const buyerUserId = `user-${randomUUID()}`;
    const tradeId = `trade-${randomUUID()}`;

    const sellerWallet = await walletService.getOrCreate(sellerUserId);
    const buyerWallet = await walletService.getOrCreate(buyerUserId);
    const tokenId = await mintAndConfirm(sellerWallet.address);

    const approval = transferApproval({
      tokenId,
      tradeId,
      sellerUserId,
      buyerUserId,
      from: sellerWallet.address,
      to: buyerWallet.address,
    });

    const { operation, created } = await transferApplication.accept(
      { idempotencyKey: randomUUID(), tradeId, sellerUserId, buyerUserId, tokenId },
      approval,
    );
    expect(created).toBe(true);
    expect(operation.status).toBe(OperationStatus.REQUESTED);

    await (transferWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const submitted = await operationRepository.findById(operation.id);
    expect(submitted?.status).toBe(OperationStatus.SUBMITTED);

    await mineBlocks(5);

    const result = await confirmationService.evaluate(submitted!);
    expect(result.outcome).toBe('CONFIRMED');
    await finalizer.apply(submitted!, result);

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const owner = await cubeNftReader.ownerOf(tokenId);
    expect(owner?.toLowerCase()).toBe(buyerWallet.address.toLowerCase());

    const activeLock = await assetLockRepository.findActive(tokenId);
    expect(activeLock).toBeNull();
  }, 30000);

  it('rejects a self-trade at accept-time', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const wallet = await walletService.getOrCreate(userId);
    const tokenId = await mintAndConfirm(wallet.address);
    const tradeId = `trade-${randomUUID()}`;

    const approval = transferApproval({
      tokenId,
      tradeId,
      sellerUserId: userId,
      buyerUserId: userId,
      from: wallet.address,
      to: wallet.address,
    });

    let caught: unknown;
    try {
      await transferApplication.accept(
        { idempotencyKey: randomUUID(), tradeId, sellerUserId: userId, buyerUserId: userId, tokenId },
        approval,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('TRANSFER_SELF_TRADE');
  }, 30000);

  it('rejects at accept-time when the claimed seller does not currently own the token', async () => {
    if (skip) return;

    const actualOwnerUserId = `user-${randomUUID()}`;
    const claimedSellerUserId = `user-${randomUUID()}`;
    const buyerUserId = `user-${randomUUID()}`;
    const actualOwnerWallet = await walletService.getOrCreate(actualOwnerUserId);
    const claimedSellerWallet = await walletService.getOrCreate(claimedSellerUserId);
    const buyerWallet = await walletService.getOrCreate(buyerUserId);
    const tokenId = await mintAndConfirm(actualOwnerWallet.address);
    const tradeId = `trade-${randomUUID()}`;

    const approval = transferApproval({
      tokenId,
      tradeId,
      sellerUserId: claimedSellerUserId,
      buyerUserId,
      from: claimedSellerWallet.address,
      to: buyerWallet.address,
    });

    let caught: unknown;
    try {
      await transferApplication.accept(
        { idempotencyKey: randomUUID(), tradeId, sellerUserId: claimedSellerUserId, buyerUserId, tokenId },
        approval,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('TRANSFER_OWNER_MISMATCH');
  }, 30000);

  it('cancelling a REQUESTED transfer releases the asset lock', async () => {
    if (skip) return;

    const sellerUserId = `user-${randomUUID()}`;
    const buyerUserId = `user-${randomUUID()}`;
    const sellerWallet = await walletService.getOrCreate(sellerUserId);
    const buyerWallet = await walletService.getOrCreate(buyerUserId);
    const tokenId = await mintAndConfirm(sellerWallet.address);
    const tradeId = `trade-${randomUUID()}`;

    const approval = transferApproval({
      tokenId,
      tradeId,
      sellerUserId,
      buyerUserId,
      from: sellerWallet.address,
      to: buyerWallet.address,
    });
    const { operation } = await transferApplication.accept(
      { idempotencyKey: randomUUID(), tradeId, sellerUserId, buyerUserId, tokenId },
      approval,
    );

    expect(await assetLockRepository.findActive(tokenId)).not.toBeNull();

    const cancelled = await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.CANCELLED,
      'CANCELLED_BY_REQUEST',
    );
    await assetLockRepository.release(cancelled.tokenId);

    expect(await assetLockRepository.findActive(tokenId)).toBeNull();
    expect((await operationRepository.findById(operation.id))?.status).toBe(OperationStatus.CANCELLED);
  }, 30000);
});
