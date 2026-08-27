import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface, Wallet } from 'ethers';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { ConfirmationService } from '../../src/domains/transaction/confirmation/confirmation.service';
import { NonceCoordinator } from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { AssetLockRepository } from '../../src/domains/transaction/persistence/asset-lock.repository';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { OperationFinalizer } from '../../src/domains/operation/finalizer/operation-finalizer.service';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 8).toString('base64');

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

describe('TASK-11 confirmation & reconciliation (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let systemSigner: SystemSignerService;
  let submission: TransactionSubmissionService;
  let operationRepository: OperationRepository;
  let assetLockRepository: AssetLockRepository;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let mintInterface: Interface;
  let chainId: number;
  let skip = false;

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(`Skipping TASK-11 integration suite: no reachable hardhat node at ${RPC_URL}.`);
      return;
    }

    setEnv();
    dataSource = createTestDataSource();
    await dataSource.initialize();

    appConfig = new AppConfigService();
    rpc = new RpcService(appConfig);
    systemSigner = new SystemSignerService(appConfig);
    const nonceCoordinator = new NonceCoordinator(dataSource, rpc);
    submission = new TransactionSubmissionService(dataSource, nonceCoordinator, rpc, systemSigner, appConfig);
    operationRepository = new OperationRepository(dataSource);
    assetLockRepository = new AssetLockRepository(dataSource);
    confirmationService = new ConfirmationService(dataSource, rpc, appConfig);
    finalizer = new OperationFinalizer(dataSource, operationRepository, assetLockRepository);
    mintInterface = new Interface(appConfig.cubeNft.abi as never);
    chainId = appConfig.cubeNft.deployment.chainId;
  });

  afterAll(async () => {
    if (skip) return;
    await dataSource.destroy();
  });

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

  it('confirms a mint once it has 5 confirmations, verifies actual ownerOf, and releases the asset lock', async () => {
    if (skip) return;

    const tokenId = randomTokenId();
    const recipient = Wallet.createRandom().address;
    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: recipient,
    });
    await assetLockRepository.acquire(tokenId, operation.id);
    await operationRepository.transition(
      operation.id,
      OperationStatus.REQUESTED,
      OperationStatus.SUBMITTED,
      'test-setup',
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
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
    });

    // Not enough confirmations yet (just the 1 block the mint itself landed in).
    const tooEarly = await confirmationService.evaluate(operation);
    expect(tooEarly.outcome).toBe('PENDING');

    await mineBlocks(4);

    const result = await confirmationService.evaluate(operation);
    expect(result.outcome).toBe('CONFIRMED');
    if (result.outcome === 'CONFIRMED') {
      expect(result.actualOwner.toLowerCase()).toBe(recipient.toLowerCase());
      expect(result.confirmations).toBeGreaterThanOrEqual(5);
    }

    // Re-fetch: `operation` is still the pre-submission snapshot (status REQUESTED at capture
    // time), but the CAS transition inside `finalizer.apply` needs the row's *current* status
    // (SUBMITTED, set above) to succeed.
    const submittedOperation = await operationRepository.findById(operation.id);
    if (!submittedOperation) {
      throw new Error('Operation vanished between submit and finalize');
    }
    await finalizer.apply(submittedOperation, result);

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const activeLock = await assetLockRepository.findActive(tokenId);
    expect(activeLock).toBeNull();
  }, 30000);

  // Note: there is no live-chain test here for the FAILED (on-chain revert) outcome. Hardhat's
  // node validates every transaction against pending state at both `eth_estimateGas` and
  // `eth_sendRawTransaction` time and rejects one that would revert *before* it ever enters the
  // mempool — there is no way to get a genuinely reverting transaction mined on a local Hardhat
  // node through any submission path. `ConfirmationService`'s FAILED branch is covered instead by
  // a unit test (`confirmation.service.spec.ts`) against a stubbed `RpcService` returning a
  // status-0 receipt directly.

  it('flags REVIEW_REQUIRED when the actual mint recipient does not match the Operation record', async () => {
    if (skip) return;

    const tokenId = randomTokenId();
    const actualRecipient = Wallet.createRandom().address;
    const wronglyRecordedRecipient = Wallet.createRandom().address;

    const { operation } = await operationRepository.createOrGet({
      idempotencyKey: randomUUID(),
      type: OperationType.MINT,
      requestHash: randomUUID().replace(/-/g, '').repeat(2).slice(0, 64),
      tokenId,
      toAddress: wronglyRecordedRecipient,
    });

    const data = mintInterface.encodeFunctionData('mintTo', [
      actualRecipient,
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
    await mineBlocks(4);

    const result = await confirmationService.evaluate(operation);
    expect(result.outcome).toBe('REVIEW_REQUIRED');
  }, 30000);
});
