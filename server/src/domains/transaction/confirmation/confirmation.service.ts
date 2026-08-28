import { Injectable, Logger } from '@nestjs/common';
import { getAddress, id as topicId, Interface } from 'ethers';
import { DataSource } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import type { Operation } from '../../operation/persistence/operation.entity';
import { TransactionAttempt } from '../persistence/transaction-attempt.entity';
import { describeRpcError } from '../rpc/rpc-error';
import { RpcService } from '../rpc/rpc.service';

const TRANSFER_EVENT_TOPIC = topicId('Transfer(address,address,uint256)');

export type ConfirmationResult =
  | {
      outcome: 'CONFIRMED';
      winningAttemptId: string;
      blockNumber: number;
      /** 검증 D7: persisted as confirmation evidence and re-checked against a fresh receipt read. */
      blockHash: string;
      receiptStatus: number;
      confirmations: number;
      actualOwner: string;
    }
  | { outcome: 'FAILED'; reason: string }
  | { outcome: 'REVIEW_REQUIRED'; reason: string }
  | { outcome: 'PENDING' };

/**
 * Pure judgment over an Operation's attempts against real chain state (TASK-11 §5:
 * `ConfirmationService.evaluate(operation)`). Never writes anything — `OperationFinalizer` is what
 * turns a result into a state transition. Checks every attempt (not just the latest) because RBF
 * means any one of them could be the one that actually landed.
 *
 * 명세 §11 conditions, in order: receipt exists → status=1 → expected event with matching tokenId/to
 * → `confirmations = latest - receiptBlock + 1 >= MIN_CONFIRMATIONS` → `ownerOf` matches → receipt
 * block hash still identical on a second read (a mismatch means a reorg is in progress: stay PENDING).
 */
@Injectable()
export class ConfirmationService {
  private readonly logger = new Logger(ConfirmationService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rpc: RpcService,
    private readonly appConfig: AppConfigService,
  ) {}

  async evaluate(operation: Operation): Promise<ConfirmationResult> {
    const attempts = await this.dataSource
      .getRepository(TransactionAttempt)
      .find({ where: { operationId: operation.id }, order: { attemptNo: 'ASC' } });
    if (attempts.length === 0) {
      return { outcome: 'PENDING' };
    }

    let anyReceiptSeen = false;
    let revertedCount = 0;

    for (const attempt of attempts) {
      let receipt;
      try {
        receipt = await this.rpc.getTransactionReceipt(attempt.txHash);
      } catch (error) {
        this.logger.warn(`Receipt lookup failed for attempt ${attempt.id}: ${describeRpcError(error)}`);
        continue;
      }
      if (!receipt) {
        continue;
      }
      anyReceiptSeen = true;

      if (receipt.status === 0) {
        revertedCount += 1;
        continue;
      }
      if (receipt.status !== 1) {
        continue;
      }

      const latestBlock = await this.rpc.getBlockNumber();
      const confirmations = latestBlock - receipt.blockNumber + 1;
      if (confirmations < this.appConfig.confirmation.blocksRequired) {
        return { outcome: 'PENDING' };
      }

      const eventTo = this.findTransferEventRecipient(receipt.logs, operation.tokenId);
      if (!eventTo) {
        return { outcome: 'REVIEW_REQUIRED', reason: 'MISSING_EXPECTED_EVENT' };
      }
      if (operation.toAddress && eventTo.toLowerCase() !== operation.toAddress.toLowerCase()) {
        return { outcome: 'REVIEW_REQUIRED', reason: 'EVENT_TO_MISMATCH' };
      }

      const actualOwner = await this.readOwnerOf(operation.tokenId);
      if (operation.toAddress && actualOwner.toLowerCase() !== operation.toAddress.toLowerCase()) {
        return { outcome: 'REVIEW_REQUIRED', reason: 'OWNER_MISMATCH' };
      }

      // 명세 §11.7: the receipt's block hash must read back identically — otherwise the block we
      // judged on was reorged out from under us and nothing above can be trusted yet.
      const recheck = await this.rpc.getTransactionReceipt(attempt.txHash);
      if (!recheck || recheck.blockHash !== receipt.blockHash) {
        this.logger.warn(
          `Receipt block hash changed on re-read for attempt ${attempt.id} — possible reorg, staying PENDING`,
        );
        return { outcome: 'PENDING' };
      }

      return {
        outcome: 'CONFIRMED',
        winningAttemptId: attempt.id,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        receiptStatus: receipt.status,
        confirmations,
        actualOwner,
      };
    }

    if (anyReceiptSeen && revertedCount === attempts.length) {
      return { outcome: 'FAILED', reason: 'ALL_ATTEMPTS_REVERTED' };
    }

    return { outcome: 'PENDING' };
  }

  /** `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` — every indexed
   * parameter lives in `topics`, not `data`, so this needs no ABI decoding beyond slicing the
   * 32-byte topic down to an address. */
  private findTransferEventRecipient(
    logs: readonly { address: string; topics: readonly string[]; data: string }[],
    tokenId: number,
  ): string | null {
    for (const log of logs) {
      if (log.topics[0] !== TRANSFER_EVENT_TOPIC || log.topics.length < 4) {
        continue;
      }
      const logTokenId = BigInt(log.topics[3] ?? '0x0');
      if (logTokenId !== BigInt(tokenId)) {
        continue;
      }
      const toTopic = log.topics[2] ?? '0x0';
      return getAddress(`0x${toTopic.slice(26)}`);
    }
    return null;
  }

  private async readOwnerOf(tokenId: number): Promise<string> {
    const iface = new Interface(['function ownerOf(uint256) view returns (address)']);
    const data = iface.encodeFunctionData('ownerOf', [tokenId]);
    const raw = await this.rpc
      .getReadProvider()
      .call({ to: this.appConfig.cubeNft.deployment.proxyAddress, data });
    const [owner] = iface.decodeFunctionResult('ownerOf', raw);
    return owner as string;
  }
}
