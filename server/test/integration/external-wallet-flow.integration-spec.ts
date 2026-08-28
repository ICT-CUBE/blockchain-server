import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Interface, Wallet } from 'ethers';
import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { OperationType } from '../../src/shared/domain/operation-type.enum';
import type {
  ReentryApprovalClaims,
  ExternalResaleApprovalClaims,
  WithdrawalApprovalClaims,
} from '../../src/shared/auth/approval-jwt/approval-jwt-claims';
import { ApiError } from '../../src/shared/http/api-error';
import { OperationIntakeService } from '../../src/shared/idempotency/operation-intake.service';
import { ConfirmationService } from '../../src/domains/transaction/confirmation/confirmation.service';
import { NonceCoordinator } from '../../src/domains/transaction/nonce/nonce-coordinator.service';
import { ApprovalJtiBindingRepository } from '../../src/domains/transaction/persistence/approval-jti-binding.repository';
import { AssetLockRepository } from '../../src/domains/transaction/persistence/asset-lock.repository';
import { NotificationOutboxRepository } from '../../src/domains/notification/persistence/notification-outbox.repository';
import { CubeNftReaderService } from '../../src/domains/transaction/rpc/cube-nft-reader.service';
import { RpcService } from '../../src/domains/transaction/rpc/rpc.service';
import { ConsentDryRunService } from '../../src/domains/transaction/rpc/consent-dry-run.service';
import {
  encodeAuthorizedTransfer,
  OWNER_CONSENT_TYPES,
  OwnerConsentPurpose,
  ownerConsentDomain,
} from '../../src/domains/transaction/signing/owner-consent';
import { SystemSignerService } from '../../src/domains/transaction/signing/system-signer.service';
import { TransactionSubmissionService } from '../../src/domains/transaction/submission/transaction-submission.service';
import { OperationFinalizer } from '../../src/domains/operation/finalizer/operation-finalizer.service';
import { OperationRepository } from '../../src/domains/operation/persistence/operation.repository';
import { FakeWeb3AuthAdapter } from '../../src/domains/wallet/providers/fake-web3auth.adapter';
import { WalletService } from '../../src/domains/wallet/application/wallet.service';
import { WalletAccount } from '../../src/domains/wallet/persistence/wallet-account.entity';
import { AuditWriter } from '../../src/domains/audit/application/audit-writer';
import { AuditRecord } from '../../src/domains/audit/persistence/audit-record.entity';
import { FailureRecord } from '../../src/domains/audit/persistence/failure-record.entity';
import { WithdrawalApplication } from '../../src/domains/nft/withdrawal/withdrawal.application';
import { WithdrawalWorker } from '../../src/domains/nft/withdrawal/withdrawal.worker';
import { ReentryApplication } from '../../src/domains/nft/reentry/reentry.application';
import { ReentryWorker } from '../../src/domains/nft/reentry/reentry.worker';
import { ExternalResaleApplication } from '../../src/domains/nft/external-resale/external-resale.application';
import { ExternalResaleWorker } from '../../src/domains/nft/external-resale/external-resale.worker';
import { createTestDataSource } from './test-data-source';

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const MINT_SIGNER_PRIVATE_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RELAYER_SIGNER_PRIVATE_KEY = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 17).toString('base64');

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

describe('TASK-09 external wallet lifecycle (integration, real local chain)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;
  let rpc: RpcService;
  let cubeNftReader: CubeNftReaderService;
  let walletService: WalletService;
  let operationRepository: OperationRepository;
  let assetLockRepository: AssetLockRepository;
  let confirmationService: ConfirmationService;
  let finalizer: OperationFinalizer;
  let mintInterface: Interface;
  let submission: TransactionSubmissionService;
  let chainId: number;
  let skip = false;

  let withdrawalApplication: WithdrawalApplication;
  let withdrawalWorker: WithdrawalWorker;
  let reentryApplication: ReentryApplication;
  let reentryWorker: ReentryWorker;
  let externalResaleApplication: ExternalResaleApplication;
  let externalResaleWorker: ExternalResaleWorker;

  async function mineBlocks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await rpc.getReadProvider().send('evm_mine', []);
    }
  }

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

  async function confirmAndFinalize(operationId: string): Promise<OperationStatus | undefined> {
    await mineBlocks(5);
    const operation = await operationRepository.findById(operationId);
    const result = await confirmationService.evaluate(operation!);
    await finalizer.apply(operation!, result);
    return (await operationRepository.findById(operationId))?.status;
  }

  beforeAll(async () => {
    skip = !(await isNodeReachable());
    if (skip) {
      console.warn(`Skipping TASK-09 integration suite: no reachable hardhat node at ${RPC_URL}.`);
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

    const auditWriter = new AuditWriter(
      dataSource.getRepository(AuditRecord),
      dataSource.getRepository(FailureRecord),
    );

    withdrawalApplication = new WithdrawalApplication(walletService, operationIntake, cubeNftReader);
    withdrawalWorker = new WithdrawalWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      walletService,
      submission,
      appConfig,
      auditWriter,
    );

    reentryApplication = new ReentryApplication(
      walletService,
      operationIntake,
      cubeNftReader,
      appConfig,
      new ConsentDryRunService(rpc, appConfig),
    );
    reentryWorker = new ReentryWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
      submission,
      appConfig,
      auditWriter,
    );

    externalResaleApplication = new ExternalResaleApplication(
      walletService,
      operationIntake,
      cubeNftReader,
      appConfig,
      new ConsentDryRunService(rpc, appConfig),
    );
    externalResaleWorker = new ExternalResaleWorker(
      dataSource,
      operationRepository,
      assetLockRepository,
      cubeNftReader,
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

  it('withdrawal: custodial wallet self-signs consent, moves the token external, and reports EXTERNAL_INACTIVE', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const wallet = await walletService.getOrCreate(userId);
    const tokenId = await mintAndConfirm(wallet.address);
    const externalWallet = Wallet.createRandom();

    const approval: WithdrawalApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.WITHDRAWAL,
      userId,
      from: wallet.address,
      to: externalWallet.address,
      riskAcknowledgementVersion: 'v1',
    };

    const { operation } = await withdrawalApplication.accept(
      {
        idempotencyKey: randomUUID(),
        userId,
        tokenId,
        externalAddress: externalWallet.address,
        riskAcknowledgementVersion: 'v1',
      },
      approval,
    );

    await (withdrawalWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    expect((await operationRepository.findById(operation.id))?.status).toBe(OperationStatus.SUBMITTED);

    const finalStatus = await confirmAndFinalize(operation.id);
    expect(finalStatus).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.metadata).toMatchObject({ rightsState: 'EXTERNAL_INACTIVE' });

    const owner = await cubeNftReader.ownerOf(tokenId);
    expect(owner?.toLowerCase()).toBe(externalWallet.address.toLowerCase());
  }, 30000);

  it('reentry: external wallet signs its own OwnerConsent, token returns to custody, reports ELIGIBLE_FOR_ACTIVATION', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const wallet = await walletService.getOrCreate(userId);
    const externalWallet = Wallet.createRandom();

    // Set up: mint to custodial, then withdraw to the external wallet directly (bypassing the
    // withdrawal HTTP/application flow, which is not what's under test here).
    const tokenId = await mintAndConfirm(wallet.address);
    await withdrawViaDirectConsent(wallet.address, externalWallet.address, tokenId);

    expect((await cubeNftReader.ownerOf(tokenId))?.toLowerCase()).toBe(externalWallet.address.toLowerCase());

    // The "challenge" step (normally POST /internal/v1/external-consent-challenges): read the
    // current nonce and build the exact typed-data payload the external wallet must sign.
    const nonce = await cubeNftReader.consentNonce(tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const message = {
      tokenId,
      currentOwner: externalWallet.address,
      from: externalWallet.address,
      to: wallet.address,
      purpose: OwnerConsentPurpose.REENTRY,
      nonce,
      deadline,
    };
    const externalSignature = await externalWallet.signTypedData(
      ownerConsentDomain(chainId, appConfig.cubeNft.deployment.proxyAddress),
      OWNER_CONSENT_TYPES,
      message,
    );

    const approval: ReentryApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.REENTRY,
      userId,
      from: externalWallet.address,
      to: wallet.address,
    };

    const { operation } = await reentryApplication.accept(
      {
        idempotencyKey: randomUUID(),
        userId,
        tokenId,
        externalAddress: externalWallet.address,
        consentNonce: nonce.toString(),
        consentDeadline: deadline.toString(),
        externalSignature,
      },
      approval,
    );

    await (reentryWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    expect((await operationRepository.findById(operation.id))?.status).toBe(OperationStatus.SUBMITTED);

    const finalStatus = await confirmAndFinalize(operation.id);
    expect(finalStatus).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const finalOperation = await operationRepository.findById(operation.id);
    expect(finalOperation?.metadata).toMatchObject({ rightsState: 'ELIGIBLE_FOR_ACTIVATION' });

    const owner = await cubeNftReader.ownerOf(tokenId);
    expect(owner?.toLowerCase()).toBe(wallet.address.toLowerCase());
  }, 30000);

  it('external resale: external wallet signs consent to the buyer, ownership moves to the buyer custodial wallet', async () => {
    if (skip) return;

    const sellerUserId = `user-${randomUUID()}`;
    const buyerUserId = `user-${randomUUID()}`;
    const sellerWallet = await walletService.getOrCreate(sellerUserId);
    const buyerWallet = await walletService.getOrCreate(buyerUserId);
    const externalWallet = Wallet.createRandom();
    const tradeId = `trade-${randomUUID()}`;

    const tokenId = await mintAndConfirm(sellerWallet.address);
    await withdrawViaDirectConsent(sellerWallet.address, externalWallet.address, tokenId);

    const nonce = await cubeNftReader.consentNonce(tokenId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const message = {
      tokenId,
      currentOwner: externalWallet.address,
      from: externalWallet.address,
      to: buyerWallet.address,
      purpose: OwnerConsentPurpose.EXTERNAL_RESALE,
      nonce,
      deadline,
    };
    const externalSignature = await externalWallet.signTypedData(
      ownerConsentDomain(chainId, appConfig.cubeNft.deployment.proxyAddress),
      OWNER_CONSENT_TYPES,
      message,
    );

    const approval: ExternalResaleApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.EXTERNAL_RESALE,
      tradeId,
      buyerUserId,
      from: externalWallet.address,
      to: buyerWallet.address,
    };

    const { operation } = await externalResaleApplication.accept(
      {
        idempotencyKey: randomUUID(),
        tradeId,
        buyerUserId,
        tokenId,
        externalSellerAddress: externalWallet.address,
        consentNonce: nonce.toString(),
        consentDeadline: deadline.toString(),
        externalSignature,
      },
      approval,
    );

    await (externalResaleWorker as unknown as { runOnce(): Promise<void> }).runOnce();
    const finalStatus = await confirmAndFinalize(operation.id);
    expect(finalStatus).toBe(OperationStatus.ONCHAIN_CONFIRMED);

    const owner = await cubeNftReader.ownerOf(tokenId);
    expect(owner?.toLowerCase()).toBe(buyerWallet.address.toLowerCase());
  }, 30000);

  it('rejects a withdrawal to the zero address at accept-time', async () => {
    if (skip) return;

    const userId = `user-${randomUUID()}`;
    const wallet = await walletService.getOrCreate(userId);
    const tokenId = await mintAndConfirm(wallet.address);
    const zeroAddress = '0x0000000000000000000000000000000000000000';

    const approval: WithdrawalApprovalClaims = {
      ...baseApprovalFields(tokenId),
      purpose: OperationType.WITHDRAWAL,
      userId,
      from: wallet.address,
      to: zeroAddress,
      riskAcknowledgementVersion: 'v1',
    };

    let caught: unknown;
    try {
      await withdrawalApplication.accept(
        {
          idempotencyKey: randomUUID(),
          userId,
          tokenId,
          externalAddress: zeroAddress,
          riskAcknowledgementVersion: 'v1',
        },
        approval,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).code).toBe('WITHDRAWAL_ZERO_ADDRESS');
  }, 30000);

  /** Directly executes a withdrawal-shaped `authorizedTransfer` (custodial -> external) as test
   * setup, bypassing the Withdrawal HTTP/application layer that other tests exercise directly. */
  async function withdrawViaDirectConsent(
    custodialAddress: string,
    externalAddress: string,
    tokenId: number,
  ): Promise<void> {
    const custodialWallet = await dataSource
      .getRepository(WalletAccount)
      .findOneOrFail({ where: { address: custodialAddress } });
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
      custodialWallet.userId,
      ownerConsentDomain(chainId, appConfig.cubeNft.deployment.proxyAddress),
      OWNER_CONSENT_TYPES,
      consent,
      OperationType.WITHDRAWAL,
    );
    const data = encodeAuthorizedTransfer(consent, signature);
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
      to: appConfig.cubeNft.deployment.proxyAddress,
      data,
    });
    await mineBlocks(1);
  }
});
