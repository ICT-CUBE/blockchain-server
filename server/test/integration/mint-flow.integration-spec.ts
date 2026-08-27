import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface } from 'ethers';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import type { MintApprovalClaims } from '../../src/shared/auth/approval-jwt/approval-jwt-claims';
import { ApiError } from '../../src/shared/http/api-error';
import { OperationIntakeService } from '../../src/shared/idempotency/operation-intake.service';
import { MintApplication } from '../../src/domains/nft/mint/mint.application';
import { MintWorker } from '../../src/domains/nft/mint/mint.worker';
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
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 11).toString('base64');

function setEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.CUBE_NFT_NETWORK = 'localhost';
  process.env.CUBE_NFT_DEPLOYMENTS_DIR = CONTRACTS_DEPLOYMENTS_DIR;
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft_test_pw@127.0.0.1:3307/cube_nft_test';
  process.env.HMAC_INBOUND_KEY_ID = 'backend-v1';
  process.env.HMAC_INBOUND_KEY_SECRET = Buffer.alloc(32, 1).toString('base64url');
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

function mintApproval(
  overrides: Partial<MintApprovalClaims> & { tokenId: number; userId: string; cubeId: string; to: string },
): MintApprovalClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    jti: randomUUID(),
    iss: 'arzone-backend',
    aud: 'arzone-blockchain-server',
    iat: now,
    exp: now + 300,
    purpose: OperationType.MINT,
    ...overrides,
  };
}

describe('TASK-07 mint flow end-to-end (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let cubeNftReader: CubeNftReaderService;
  let walletService: WalletService;
  let mintApplication: MintApplication;
  let mintWorker: MintWorker;
  let operationRepository: OperationRepository;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let mintInterface: Interface;
  let chainId: number;
  let skip = false;

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(`Skipping TASK-07 mint flow integration suite: no reachable hardhat node at ${RPC_URL}.`);
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
    mintApplication = new MintApplication(walletService, operationIntake, cubeNftReader);

    const nonceCoordinator = new NonceCoordinator(dataSource, rpc);
    const systemSigner = new SystemSignerService(appConfig);
    const submission = new TransactionSubmissionService(
      dataSource,
      nonceCoordinator,
      rpc,
      systemSigner,
      appConfig,
    );
    operationRepository = new OperationRepository(dataSource);
    const assetLockRepository = new AssetLockRepository(dataSource);
    mintWorker = new MintWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      submission,
      appConfig,
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

  it('accept -> worker submits -> reconciliation confirms, end to end', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const cubeId = `cube-${randomUUID()}`;
    const tokenId = randomTokenId();

    const wallet = await walletService.getOrCreate(userId);
    const approval = mintApproval({ tokenId, userId, cubeId, to: wallet.address });

    const { operation, created } = await mintApplication.accept(
      { idempotencyKey: randomUUID(), userId, cubeId, tokenId },
      approval,
    );
    expect(created).toBe(true);
    expect(operation.status).toBe(OperationStatus.REQUESTED);

    await (mintWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const submitted = await operationRepository.findById(operation.id);
    expect(submitted?.status).toBe(OperationStatus.SUBMITTED);

    await mineBlocks(5);

    const result = await confirmationService.evaluate(submitted!);
    expect(result.outcome).toBe('CONFIRMED');
    await finalizer.apply(submitted!, result);

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const owner = await cubeNftReader.ownerOf(tokenId);
    expect(owner?.toLowerCase()).toBe(wallet.address.toLowerCase());
  }, 30000);

  it('rejects at accept-time when the token is already minted to a different address', async () => {
    if (skip) return;

    const ownerUserId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const cubeId = `cube-${randomUUID()}`;
    const tokenId = randomTokenId();

    const ownerWallet = await walletService.getOrCreate(ownerUserId);
    const firstApproval = mintApproval({ tokenId, userId: ownerUserId, cubeId, to: ownerWallet.address });
    const { operation } = await mintApplication.accept(
      { idempotencyKey: randomUUID(), userId: ownerUserId, cubeId, tokenId },
      firstApproval,
    );
    await (mintWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    await mineBlocks(5);
    const confirmed = await confirmationService.evaluate((await operationRepository.findById(operation.id))!);
    await finalizer.apply((await operationRepository.findById(operation.id))!, confirmed);
    expect((await operationRepository.findById(operation.id))?.status).toBe(
      OperationStatus.ONCHAIN_CONFIRMED,
    );

    const otherWallet = await walletService.getOrCreate(otherUserId);
    const secondApproval = mintApproval({ tokenId, userId: otherUserId, cubeId, to: otherWallet.address });

    let caught: unknown;
    try {
      await mintApplication.accept(
        { idempotencyKey: randomUUID(), userId: otherUserId, cubeId, tokenId },
        secondApproval,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('MINT_TOKEN_OWNER_CONFLICT');
    expect((caught as ApiError).getStatus()).toBe(409);
  }, 30000);

  it('worker finalizes idempotently when the token is already minted to the expected owner', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const cubeId = `cube-${randomUUID()}`;
    const tokenId = randomTokenId();
    const wallet = await walletService.getOrCreate(userId);

    // Mint it once directly against the chain, bypassing our own flow, to simulate "this Operation
    // was created, its mint already landed by some other path, but the Operation row is still
    // REQUESTED" (e.g. a crash right before the worker updated it).
    const data = mintInterface.encodeFunctionData('mintTo', [
      wallet.address,
      tokenId,
      `ipfs://test/${tokenId}.json`,
    ]);
    const nonceCoordinator = new NonceCoordinator(dataSource, rpc);
    const systemSigner = new SystemSignerService(appConfig);
    const directSubmission = new TransactionSubmissionService(
      dataSource,
      nonceCoordinator,
      rpc,
      systemSigner,
      appConfig,
    );
    const bootstrapOperation = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: wallet.address,
    });
    await directSubmission.submit({
      operationId: bootstrapOperation.operation.id,
      chainId,
      signerRole: 'mint',
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
    });

    const approval = mintApproval({ tokenId, userId, cubeId, to: wallet.address });
    const { operation } = await mintApplication.accept(
      { idempotencyKey: randomUUID(), userId, cubeId, tokenId },
      approval,
    );

    await (mintWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);
  }, 30000);
});
