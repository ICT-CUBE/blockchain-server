import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import path from 'node:path';

import { Interface, Wallet } from 'ethers';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import { ConfirmationService } from '../../src/domains/transaction/confirmation/confirmation.service';
import { NonceCoordinator } from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { AssetLockRepository } from '../../src/domains/transaction/persistence/asset-lock.repository';
import { AuditWriter } from '../../src/domains/audit/application/audit-writer';
import { AuditRecord } from '../../src/domains/audit/persistence/audit-record.entity';
import { FailureRecord } from '../../src/domains/audit/persistence/failure-record.entity';
import { OperationFinalizer } from '../../src/domains/operation/finalizer/operation-finalizer.service';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { NotificationDeliveryService } from '../../src/domains/notification/application/notification-delivery.service';
import { NotificationDeliveryWorker } from '../../src/domains/notification/application/notification-delivery.worker';
import {
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '../../src/domains/notification/persistence/notification-delivery.entity';
import { NotificationOutboxRepository } from '../../src/domains/notification/persistence/notification-outbox.repository';
import { createMockReceiverServer } from '../../mock-receiver/server';
import { unmintedTokenId } from '../helpers/unminted-token-id';
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MOCK_RECEIVER_PORT = 4210;
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 19).toString('base64');
const HMAC_OUTBOUND_SECRET = Buffer.alloc(32, 23).toString('base64url');

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
  process.env.CONFIRMATION_BLOCKS_REQUIRED = '5';
  process.env.NOTIFICATION_CALLBACK_URL = `http://127.0.0.1:${MOCK_RECEIVER_PORT}/webhook`;
  process.env.HMAC_OUTBOUND_KEY_ID = 'outbound-v1';
  process.env.HMAC_OUTBOUND_KEY_SECRET = HMAC_OUTBOUND_SECRET;
  process.env.NOTIFICATION_TIMEOUT_MS = '2000';
  process.env.NOTIFICATION_MAX_AUTO_RETRIES = '3';
  process.env.NOTIFICATION_BASE_BACKOFF_MS = '50';
  process.env.NOTIFICATION_MAX_BACKOFF_MS = '200';
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

describe('TASK-12 notification delivery (integration, real local chain + real HTTP receiver)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let operationRepository: OperationRepository;
  let assetLockRepository: AssetLockRepository;
  let notificationOutbox: NotificationOutboxRepository;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let deliveryService: NotificationDeliveryService;
  let deliveryWorker: NotificationDeliveryWorker;
  let submission: TransactionSubmissionService;
  let mintInterface: Interface;
  let chainId: number;
  let skip = false;

  let receiverServer: Server;
  let receiverSeen: { notificationId: string; duplicate: boolean }[] = [];
  let receiverFailCount = 0;

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

  async function mintConfirmAndEnqueueNotification(): Promise<{ operationId: string; tokenId: number }> {
    const tokenId = await unmintedTokenId(RPC_URL, appConfig.cubeNft.deployment.proxyAddress);
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
    await mineBlocks(5);

    const submitted = await operationRepository.findById(operation.id);
    const result = await confirmationService.evaluate(submitted!);
    expect(result.outcome).toBe('CONFIRMED');
    await finalizer.apply(submitted!, result);

    const confirmed = await operationRepository.findById(operation.id);
    expect(confirmed?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    return { operationId: operation.id, tokenId };
  }

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(`Skipping TASK-12 integration suite: no reachable hardhat node at ${RPC_URL}.`);
      return;
    }

    setEnv();
    dataSource = createTestDataSource();
    await dataSource.initialize();
    // Other integration spec files in the same `--runInBand` run confirm Operations of their own
    // against this same shared DB, and OperationFinalizer unconditionally enqueues a notification
    // on every CONFIRMED — clear any such stray PENDING rows so claimDueBatch() only ever sees
    // this file's own notifications (real cross-file order-independence, not the suite's problem
    // to solve on this file's behalf).
    await dataSource.query('DELETE FROM outbox_notifications');

    appConfig = new AppConfigService();
    rpc = new RpcService(appConfig);
    const nonceCoordinator = new NonceCoordinator(dataSource, rpc, appConfig);
    const systemSigner = new SystemSignerService(appConfig);
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
    assetLockRepository = new AssetLockRepository(dataSource);
    notificationOutbox = new NotificationOutboxRepository(dataSource);
    finalizer = new OperationFinalizer(
      dataSource,
      operationRepository,
      assetLockRepository,
      notificationOutbox,
    );
    confirmationService = new ConfirmationService(dataSource, rpc, appConfig);
    const auditWriter = new AuditWriter(
      dataSource.getRepository(AuditRecord),
      dataSource.getRepository(FailureRecord),
    );
    deliveryService = new NotificationDeliveryService(
      notificationOutbox,
      operationRepository,
      appConfig,
      auditWriter,
    );
    deliveryWorker = new NotificationDeliveryWorker(notificationOutbox, deliveryService, appConfig);

    mintInterface = new Interface(appConfig.cubeNft.abi as never);
    chainId = appConfig.cubeNft.deployment.chainId;

    receiverServer = createMockReceiverServer({
      hmacSecret: Buffer.from(HMAC_OUTBOUND_SECRET, 'base64url'),
      port: MOCK_RECEIVER_PORT,
      get failCount() {
        return receiverFailCount;
      },
      onReceived: (notificationId, duplicate) => {
        receiverSeen.push({ notificationId, duplicate });
      },
    });
    await new Promise<void>((resolve) => receiverServer.listen(MOCK_RECEIVER_PORT, resolve));
  });

  afterAll(async () => {
    if (skip) return;
    await new Promise<void>((resolve) => receiverServer.close(() => resolve()));
    await dataSource.destroy();
  });

  beforeEach(async () => {
    if (skip) return;
    receiverSeen = [];
    receiverFailCount = 0;
    // Isolate each `it` block too — a RETRYING row left by a previous test in this same file
    // would otherwise also be claimed by a later test's runOnce() call.
    await dataSource.query('DELETE FROM outbox_notifications');
  });

  it('delivers a confirmed operation notification and completes the Operation', async () => {
    if (skip) return;

    const { operationId } = await mintConfirmAndEnqueueNotification();

    await (deliveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const finalOperation = await operationRepository.findById(operationId);
    expect(finalOperation?.status).toBe(OperationStatus.COMPLETED);
    expect(receiverSeen).toHaveLength(1);
    expect(receiverSeen[0]?.duplicate).toBe(false);
  }, 30000);

  it('retries a failing receiver with backoff and eventually delivers', async () => {
    if (skip) return;

    receiverFailCount = 2;
    const { operationId } = await mintConfirmAndEnqueueNotification();

    // First tick: fails (receiver returns 500), goes to RETRYING.
    await (deliveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    let operation = await operationRepository.findById(operationId);
    expect(operation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    // Wait past the (short, test-configured) backoff window, then retry until delivered.
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await (deliveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();
      operation = await operationRepository.findById(operationId);
      if (operation?.status === OperationStatus.COMPLETED) break;
    }

    expect(operation?.status).toBe(OperationStatus.COMPLETED);
  }, 30000);

  it('reaches REVIEW_REQUIRED after exhausting auto-retries, then a manual redeliver succeeds', async () => {
    if (skip) return;

    receiverFailCount = 999; // always fail until we lower it back down for the manual redeliver
    const { operationId } = await mintConfirmAndEnqueueNotification();
    const enqueued = await dataSource
      .getRepository(NotificationDelivery)
      .findOneOrFail({ where: { operationId } });
    const notification = await notificationOutbox.findByNotificationId(enqueued.notificationId);
    expect(notification).not.toBeNull();

    for (let i = 0; i < appConfig.notification.maxAutoRetries + 1; i += 1) {
      await (deliveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    const exhausted = await notificationOutbox.findByNotificationId(notification!.notificationId);
    expect(exhausted?.status).toBe(NotificationDeliveryStatus.REVIEW_REQUIRED);

    const operationBeforeRedeliver = await operationRepository.findById(operationId);
    expect(operationBeforeRedeliver?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    receiverFailCount = 0;
    const redelivered = await deliveryService.redeliver(notification!.notificationId);
    expect(redelivered.status).toBe(NotificationDeliveryStatus.DELIVERED);

    const finalOperation = await operationRepository.findById(operationId);
    expect(finalOperation?.status).toBe(OperationStatus.COMPLETED);
  }, 30000);

  it('GET-equivalent lookup (findById) returns the confirmed result even while notification delivery is failing', async () => {
    if (skip) return;

    receiverFailCount = 999;
    const { operationId, tokenId } = await mintConfirmAndEnqueueNotification();

    await (deliveryWorker as unknown as { runOnce(): Promise<void> }).runOnce();

    const operation = await operationRepository.findById(operationId);
    expect(operation?.status).toBe(OperationStatus.ONCHAIN_CONFIRMED);
    expect(operation?.tokenId).toBe(tokenId);
  }, 30000);
});
