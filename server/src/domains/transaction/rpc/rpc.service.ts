import { Injectable, Logger } from '@nestjs/common';
import { JsonRpcProvider, type TransactionReceipt } from 'ethers';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { describeRpcError, summarizeRpcError } from './rpc-error';

export interface FeeEstimate {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface ReceiptSummary {
  status: number | null;
  blockNumber: number;
  blockHash: string;
  logs: readonly { address: string; topics: readonly string[]; data: string }[];
}

/**
 * Primary/backup RPC failover (NFR-012~014, TASK-10 §5 "Primary 실패 시 ... Backup에 제출"). Every
 * call tries Primary first and falls back to Backup only on failure — this is deliberately not a
 * quorum/majority `FallbackProvider`, since the plan calls for an explicit ordered failover, not
 * consensus between endpoints. Also exposes the read-only `Provider` other services (e.g. TASK-11's
 * `ownerOf` checks) build `ethers.Contract` instances against.
 *
 * 검증 D11: nothing in this class ever logs `error.message` verbatim — ethers embeds the full
 * JSON-RPC request (signed raw transactions included) in it. `describeRpcError` is the only form
 * an RPC error takes in a log line.
 */
@Injectable()
export class RpcService {
  private readonly logger = new Logger(RpcService.name);
  private readonly primary: JsonRpcProvider;
  private readonly backup: JsonRpcProvider | null;

  constructor(appConfig: AppConfigService) {
    const { rpc } = appConfig.submission;
    // ethers' AbstractProvider coalesces identical low-level requests (same method+params, e.g.
    // getBlockNumber()) made within a 250ms window by default and returns the same cached result —
    // fine for a dapp minimizing RPC cost, wrong here: TASK-11's confirmation math reads
    // getBlockNumber() right after driving the chain forward (mining/broadcasting), and a stale
    // cached block number under-counts confirmations. Disabled everywhere in this service.
    this.primary = new JsonRpcProvider(rpc.primaryUrl, undefined, { cacheTimeout: -1 });
    this.backup = rpc.backupUrl ? new JsonRpcProvider(rpc.backupUrl, undefined, { cacheTimeout: -1 }) : null;
  }

  private async withFailover<T>(
    operationName: string,
    op: (provider: JsonRpcProvider) => Promise<T>,
  ): Promise<T> {
    try {
      return await op(this.primary);
    } catch (error) {
      if (!this.backup) {
        throw error;
      }
      this.logger.warn(
        `Primary RPC failed for ${operationName} (${describeRpcError(error)}); retrying against backup`,
      );
      return op(this.backup);
    }
  }

  /** The read-only provider `ethers.Contract` instances should be built against. Always the
   * Primary endpoint — read failover for contract calls is out of scope for TASK-10 (TASK-11 only
   * ever reads `ownerOf`, which is cheap to retry at the call site if it ever matters). */
  getReadProvider(): JsonRpcProvider {
    return this.primary;
  }

  async getChainId(): Promise<number> {
    const network = await this.withFailover('getChainId', (p) => p.getNetwork());
    return Number(network.chainId);
  }

  async getPendingNonce(address: string): Promise<number> {
    return this.withFailover('getPendingNonce', (p) => p.getTransactionCount(address, 'pending'));
  }

  async getFeeData(): Promise<FeeEstimate> {
    return this.withFailover('getFeeData', async (p) => {
      const fee = await p.getFeeData();
      if (fee.maxFeePerGas === null || fee.maxPriorityFeePerGas === null) {
        throw new Error('RPC provider did not return EIP-1559 fee data (maxFeePerGas/maxPriorityFeePerGas)');
      }
      return { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas };
    });
  }

  async estimateGas(tx: { to: string; data: string; from: string; value?: bigint }): Promise<bigint> {
    return this.withFailover('estimateGas', (p) => p.estimateGas(tx));
  }

  /** `eth_call` dry-run of exactly the calldata a worker would later submit, from the given sender
   * (검증 D3: "실제 relayer 주소를 from으로 사용해 Operation·lock 생성 전에 eth_call dry-run"). Rejects
   * with ethers' `CALL_EXCEPTION` (carrying revert `data`) on a deterministic revert, or with a
   * network/server error when the RPC itself is unavailable — callers tell the two apart via
   * `summarizeRpcError`. */
  async simulateCall(tx: { from: string; to: string; data: string; value?: bigint }): Promise<string> {
    return this.withFailover('simulateCall', (p) => p.call(tx));
  }

  /** Broadcasts a signed raw transaction. Treats "already known" / "nonce too low" errors as
   * success — both mean a prior attempt (this call racing its own retry, or Primary having actually
   * accepted it despite an error reaching us) already got the same transaction into the mempool or
   * chain, which is exactly the outcome we wanted (TASK-10 §5: recovery resubmits the identical raw
   * transaction, so it must be idempotent). */
  async broadcastTransaction(rawTransactionHex: string): Promise<void> {
    try {
      await this.withFailover('broadcastTransaction', (p) => p.broadcastTransaction(rawTransactionHex));
    } catch (error) {
      const summary = summarizeRpcError(error);
      if (summary.class === 'ALREADY_KNOWN' || summary.class === 'NONCE_TOO_LOW') {
        return;
      }
      throw error;
    }
  }

  async getTransactionReceipt(txHash: string): Promise<ReceiptSummary | null> {
    const receipt: TransactionReceipt | null = await this.withFailover('getTransactionReceipt', (p) =>
      p.getTransactionReceipt(txHash),
    );
    if (!receipt) {
      return null;
    }
    return {
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      logs: receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })),
    };
  }

  async getBlockNumber(): Promise<number> {
    return this.withFailover('getBlockNumber', (p) => p.getBlockNumber());
  }
}
