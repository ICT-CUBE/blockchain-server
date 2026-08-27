import { id as topicId } from 'ethers';
import type { DataSource } from 'typeorm';

import type { AppConfigService } from '../../../shared/config/app-config.service';
import { OperationType } from '../../../shared/domain/operation-type.enum';
import { OperationStatus } from '../../../shared/domain/operation-status.enum';
import type { Operation } from '../../operation/persistence/operation.entity';
import { ConfirmationService } from './confirmation.service';
import type { ReceiptSummary } from '../rpc/rpc.service';

const TRANSFER_TOPIC = topicId('Transfer(address,address,uint256)');
const PROXY_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

function topicAddress(address: string): string {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function topicUint(value: number): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'operation-1',
    type: OperationType.MINT,
    status: OperationStatus.SUBMITTED,
    idempotencyKey: 'idem-1',
    requestHash: 'a'.repeat(64),
    tokenId: 42,
    fromAddress: null,
    toAddress: '0x1111111111111111111111111111111111111111',
    reviewReason: null,
    failureCode: null,
    metadata: null,
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface FakeAttempt {
  id: string;
  attemptNo: number;
  txHash: string;
}

function makeConfirmationService(params: {
  attempts: FakeAttempt[];
  receiptsByTxHash: Record<string, ReceiptSummary | null>;
  latestBlock: number;
  blocksRequired?: number;
}): ConfirmationService {
  const fakeDataSource = {
    getRepository: () => ({
      find: () => Promise.resolve(params.attempts),
    }),
  } as unknown as DataSource;

  const fakeRpc = {
    getTransactionReceipt: (txHash: string) => Promise.resolve(params.receiptsByTxHash[txHash] ?? null),
    getBlockNumber: () => Promise.resolve(params.latestBlock),
    getReadProvider: () => ({
      call: () => Promise.reject(new Error('ownerOf should not be called in this scenario')),
    }),
  };

  const fakeAppConfig = {
    confirmation: { blocksRequired: params.blocksRequired ?? 5 },
    cubeNft: { deployment: { proxyAddress: PROXY_ADDRESS } },
  } as unknown as AppConfigService;

  return new ConfirmationService(
    fakeDataSource,
    fakeRpc as unknown as ConstructorParameters<typeof ConfirmationService>[1],
    fakeAppConfig,
  );
}

describe('ConfirmationService', () => {
  it('returns PENDING when no attempts exist yet', async () => {
    const service = makeConfirmationService({ attempts: [], receiptsByTxHash: {}, latestBlock: 100 });
    const result = await service.evaluate(makeOperation());
    expect(result.outcome).toBe('PENDING');
  });

  it('returns PENDING when no receipt is available yet', async () => {
    const service = makeConfirmationService({
      attempts: [{ id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' }],
      receiptsByTxHash: {},
      latestBlock: 100,
    });
    const result = await service.evaluate(makeOperation());
    expect(result.outcome).toBe('PENDING');
  });

  it('returns FAILED when every attempt has a reverted (status 0) receipt', async () => {
    const service = makeConfirmationService({
      attempts: [
        { id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' },
        { id: 'attempt-2', attemptNo: 2, txHash: '0xbbb' },
      ],
      receiptsByTxHash: {
        '0xaaa': { status: 0, blockNumber: 10, blockHash: '0xblock', logs: [] },
        '0xbbb': { status: 0, blockNumber: 11, blockHash: '0xblock2', logs: [] },
      },
      latestBlock: 20,
    });
    const result = await service.evaluate(makeOperation());
    expect(result).toEqual({ outcome: 'FAILED', reason: 'ALL_ATTEMPTS_REVERTED' });
  });

  it('returns PENDING (not FAILED) when one attempt reverted but another has no receipt yet', async () => {
    const service = makeConfirmationService({
      attempts: [
        { id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' },
        { id: 'attempt-2', attemptNo: 2, txHash: '0xbbb' },
      ],
      receiptsByTxHash: {
        '0xaaa': { status: 0, blockNumber: 10, blockHash: '0xblock', logs: [] },
      },
      latestBlock: 20,
    });
    const result = await service.evaluate(makeOperation());
    expect(result.outcome).toBe('PENDING');
  });

  it('returns PENDING when a successful receipt exists but has fewer than the required confirmations', async () => {
    const operation = makeOperation({ tokenId: 42 });
    const service = makeConfirmationService({
      attempts: [{ id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' }],
      receiptsByTxHash: {
        '0xaaa': {
          status: 1,
          blockNumber: 18,
          blockHash: '0xblock',
          logs: [
            {
              address: PROXY_ADDRESS,
              topics: [
                TRANSFER_TOPIC,
                topicAddress('0x0'),
                topicAddress(operation.toAddress ?? '0x0'),
                topicUint(42),
              ],
              data: '0x',
            },
          ],
        },
      },
      latestBlock: 20, // confirmations = 20 - 18 + 1 = 3 < 5
    });
    const result = await service.evaluate(operation);
    expect(result.outcome).toBe('PENDING');
  });

  it('returns REVIEW_REQUIRED when no Transfer event for the expected tokenId is found', async () => {
    const operation = makeOperation({ tokenId: 42 });
    const service = makeConfirmationService({
      attempts: [{ id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' }],
      receiptsByTxHash: {
        '0xaaa': { status: 1, blockNumber: 10, blockHash: '0xblock', logs: [] },
      },
      latestBlock: 20,
    });
    const result = await service.evaluate(operation);
    expect(result).toEqual({ outcome: 'REVIEW_REQUIRED', reason: 'MISSING_EXPECTED_EVENT' });
  });

  it('returns REVIEW_REQUIRED when the Transfer event recipient does not match the Operation record', async () => {
    const operation = makeOperation({ tokenId: 42, toAddress: '0x1111111111111111111111111111111111111111' });
    const service = makeConfirmationService({
      attempts: [{ id: 'attempt-1', attemptNo: 1, txHash: '0xaaa' }],
      receiptsByTxHash: {
        '0xaaa': {
          status: 1,
          blockNumber: 10,
          blockHash: '0xblock',
          logs: [
            {
              address: PROXY_ADDRESS,
              topics: [
                TRANSFER_TOPIC,
                topicAddress('0x0'),
                topicAddress('0x2222222222222222222222222222222222222222'),
                topicUint(42),
              ],
              data: '0x',
            },
          ],
        },
      },
      latestBlock: 20,
    });
    const result = await service.evaluate(operation);
    expect(result).toEqual({ outcome: 'REVIEW_REQUIRED', reason: 'EVENT_TO_MISMATCH' });
  });
});
