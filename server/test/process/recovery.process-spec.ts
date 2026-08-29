import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync } from 'node:fs';
import path from 'node:path';

import { keccak256 } from 'ethers';
import jwt from 'jsonwebtoken';
import type { DataSource } from 'typeorm';

import { buildCanonicalString, computeHmacSignatureHex } from '../../src/shared/auth/hmac/canonical-request';
import { decryptRawTransaction } from '../../src/domains/transaction/encryption/raw-transaction-cipher';
import { OperationStatus } from '../../src/shared/domain/operation-status.enum';
import { createTestDataSource } from '../integration/test-data-source';

/**
 * T10 §5 ("제출 전 중단은 저장 raw transaction으로 동일 txHash를 제출") — the *real* process-kill
 * recovery test the plan's T10 row calls for, and which the in-process `restart-persistence`
 * integration spec (a DataSource close/reopen) does not actually exercise.
 *
 * A separate opt-in suite (`npm run test:integration:process`), excluded from the default
 * regression, because it:
 *   - boots the compiled server as a genuine child process (`node dist/main.js` — the
 *     `test:process` npm script runs `nest build` first),
 *   - `SIGKILL`s it mid-flight (no graceful shutdown, no `app.close()`), and
 *   - starts a second, independent process that must pick the work back up.
 *
 * The broadcast-pause hook (`SUBMISSION_PAUSE_BEFORE_BROADCAST`) makes the crash window
 * deterministic: process A signs the mint tx and commits the encrypted raw tx as a SIGNED
 * `transaction_attempts` row, then stops — exactly "crashed after committing the raw tx, before
 * broadcast". The hook only takes effect under `NODE_ENV=test` AND the flag (see `env.schema.ts` /
 * `app-config.ts`), so it can never arm in production. Process B starts *without* the flag; its
 * `SignedAttemptRecoveryWorker` must decrypt the stored raw tx, re-broadcast it, and drive the
 * Operation to ONCHAIN_CONFIRMED with the **same txHash** process A computed.
 *
 * Prerequisites (same as `npm run test:integration`):
 *   - a Hardhat node on http://127.0.0.1:8545 with CubeNFT deployed (`contracts/deployments/localhost.json`),
 *   - the test MySQL from `DATABASE_URL` with all migrations applied.
 * Both are asserted in `beforeAll` — this suite throws rather than silently skipping.
 */

const SERVER_DIR = path.join(__dirname, '..', '..');
const DEPLOYMENTS_DIR = path.join(SERVER_DIR, '..', 'contracts', 'deployments');
const RPC_URL = 'http://127.0.0.1:8545';
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft_test_pw@127.0.0.1:3307/cube_nft_test';
const PORT = 3399;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const HMAC_KEY_ID = 'backend-v1';
const HMAC_SECRET = Buffer.alloc(32, 1);
const APPROVAL_JWT_SECRET = Buffer.alloc(32, 2);
const APPROVAL_JWT_ISSUER = 'arzone-backend';
const APPROVAL_JWT_AUDIENCE = 'arzone-blockchain-server';
const RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 9);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const VOLATILE_TABLES = [
  'approval_jti_bindings',
  'asset_locks',
  'audit_records',
  'failure_records',
  'hmac_nonces',
  'metadata_dependencies',
  'operation_state_history',
  'operations',
  'outbox_notifications',
  'signer_locks',
  'signer_nonce_reservations',
  'transaction_attempts',
  'wallet_accounts',
];

/** Env every child gets. `localhost` is in `LOCAL_NETWORK_NAMES`, so RPC URL and the Hardhat dev
 * signer keys are filled in by `env.schema.ts`; only the secrets the test itself must also know
 * (HMAC, approval JWT, raw-tx key) are pinned here. `pauseBeforeBroadcast` is added per child. */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    CUBE_NFT_NETWORK: 'localhost',
    CUBE_NFT_DEPLOYMENTS_DIR: DEPLOYMENTS_DIR,
    DATABASE_URL,
    HMAC_INBOUND_KEY_ID: HMAC_KEY_ID,
    HMAC_INBOUND_KEY_SECRET: HMAC_SECRET.toString('base64url'),
    HMAC_OPERATOR_KEY_ID: 'operator-v1',
    HMAC_OPERATOR_KEY_SECRET: Buffer.alloc(32, 101).toString('base64url'),
    APPROVAL_JWT_SECRET: APPROVAL_JWT_SECRET.toString('base64url'),
    APPROVAL_JWT_ISSUER,
    APPROVAL_JWT_AUDIENCE,
    RAW_TX_ENCRYPTION_KEY: RAW_TX_ENCRYPTION_KEY.toString('base64'),
    NOTIFICATION_CALLBACK_URL: 'http://127.0.0.1:4100/webhook',
    HMAC_OUTBOUND_KEY_ID: 'outbound-v1',
    HMAC_OUTBOUND_KEY_SECRET: Buffer.alloc(32, 10).toString('base64url'),
    CONFIRMATION_BLOCKS_REQUIRED: '2',
    SUBMISSION_POLL_INTERVAL_MS: '1000',
    RECONCILIATION_POLL_INTERVAL_MS: '1500',
    ...extra,
  };
}

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await response.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`RPC ${method} failed: ${JSON.stringify(json.error)}`);
  return json.result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RunningServer {
  child: ChildProcess;
  log: () => string;
  /** True once the child's `exit` event has fired. `child.exitCode` is unreliable here — it stays
   * `null` for a process terminated by a signal (SIGKILL), so a guard on it would loop forever. */
  hasExited: () => boolean;
  waitExit: () => Promise<void>;
}

function startServer(label: string, extraEnv: Record<string, string>): RunningServer {
  const chunks: string[] = [];
  const child = spawn('node', ['dist/main.js'], {
    cwd: SERVER_DIR,
    env: childEnv(extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (buffer: Buffer): void => {
    chunks.push(buffer.toString());
    if (chunks.length > 400) chunks.splice(0, chunks.length - 400);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  let exited = false;
  let markExited: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  child.on('exit', (code, signal) => {
    exited = true;
    chunks.push(`\n[${label}] exited code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    markExited();
  });

  return { child, log: () => chunks.join(''), hasExited: () => exited, waitExit: () => exitPromise };
}

async function waitForReady(server: RunningServer, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.hasExited()) {
      throw new Error(`server exited before becoming ready:\n${server.log()}`);
    }
    try {
      const response = await fetch(`${BASE_URL}/ready`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(500);
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms:\n${server.log()}`);
}

async function killHard(server: RunningServer | undefined): Promise<void> {
  if (!server || server.hasExited()) return;
  server.child.kill('SIGKILL');
  await server.waitExit();
}

function hmacHeaders(method: string, requestPath: string, bodyString: string): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  const canonical = buildCanonicalString({
    method,
    path: requestPath,
    query: {},
    timestamp,
    nonce,
    rawBody: Buffer.from(bodyString, 'utf8'),
  });
  return {
    'Content-Type': 'application/json',
    'X-ARZONE-Key-Id': HMAC_KEY_ID,
    'X-ARZONE-Timestamp': timestamp,
    'X-ARZONE-Nonce': nonce,
    'X-ARZONE-Signature': computeHmacSignatureHex(HMAC_SECRET, canonical),
  };
}

async function httpJson(
  method: string,
  requestPath: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bodyString = JSON.stringify(body);
  const headers = hmacHeaders(method, requestPath, bodyString);
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await fetch(`${BASE_URL}${requestPath}`, { method, headers, body: bodyString });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: response.status, body: parsed };
}

describe('T10 process-kill recovery (real child process, SIGKILL)', () => {
  let dataSource: DataSource;
  let serverA: RunningServer | undefined;
  let serverB: RunningServer | undefined;

  beforeAll(async () => {
    // Prerequisite 1: Hardhat node with the CubeNFT deployment.
    try {
      await rpc('eth_chainId');
    } catch (error) {
      throw new Error(
        `No Hardhat node at ${RPC_URL}. Start it (and deploy CubeNFT) exactly as for ` +
          `\`npm run test:integration\`.`,
        { cause: error },
      );
    }

    // Prerequisite 2: the test DB, migrations applied. createTestDataSource() throws a clear
    // message if DATABASE_URL is unset; a missing table surfaces on the first truncate below.
    process.env.DATABASE_URL = DATABASE_URL;
    dataSource = createTestDataSource();
    await dataSource.initialize();

    await dataSource.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of VOLATILE_TABLES) {
      await dataSource.query(`TRUNCATE TABLE \`${table}\``);
    }
    await dataSource.query('SET FOREIGN_KEY_CHECKS = 1');

    // `node dist/main.js` must reflect the current source (incl. the pause hook). The `test:process`
    // npm script runs `nest build` before Jest; fail loudly if this spec was run some other way.
    try {
      accessSync(path.join(SERVER_DIR, 'dist', 'main.js'));
    } catch {
      throw new Error(
        'dist/main.js is missing — run `npm run test:integration:process` (which builds first).',
      );
    }
  }, 60_000);

  afterAll(async () => {
    await killHard(serverA);
    await killHard(serverB);
    if (dataSource?.isInitialized) await dataSource.destroy();
  }, 30_000);

  it('a SIGKILL after the raw tx is committed (SIGNED) is recovered by a fresh process with the same txHash', async () => {
    const tokenId = Math.floor(Math.random() * 9000) + 1;
    const userId = `t10-user-${randomUUID().slice(0, 8)}`;
    const cubeId = `t10-cube-${tokenId}`;

    // --- process A: pauses right before broadcast ---
    serverA = startServer('A', { SUBMISSION_PAUSE_BEFORE_BROADCAST: '1' });
    await waitForReady(serverA);

    // metadata (HMAC only)
    const metadata = await httpJson('POST', '/internal/v1/metadata', {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`t10-image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });
    expect(metadata.status).toBe(200);

    // custodial wallet (HMAC only) — gives us the real `to` the approval token must carry
    const wallet = await httpJson('POST', '/internal/v1/wallets', { userId });
    expect(wallet.status).toBe(200);
    const toAddress = wallet.body.address as string;

    // mint (HMAC + approval JWT)
    const idempotencyKey = randomUUID();
    const approval = jwt.sign(
      { jti: randomUUID(), purpose: 'MINT', tokenId, userId, cubeId, to: toAddress },
      APPROVAL_JWT_SECRET,
      { algorithm: 'HS256', issuer: APPROVAL_JWT_ISSUER, audience: APPROVAL_JWT_AUDIENCE, expiresIn: 1800 },
    );
    const mint = await httpJson(
      'POST',
      '/internal/v1/mints',
      { idempotencyKey, userId, cubeId, tokenId },
      approval,
    );
    expect(mint.status).toBe(202);
    const operationId = mint.body.operationId as string;

    // Wait for process A to sign + commit the raw tx (SIGNED attempt), which is as far as the
    // pause hook lets it go.
    const signed = await pollForAttempt(operationId, (row) => row.status === 'SIGNED' && !!row.ct, 60_000);
    const signedTxHash: string = signed.txHash;
    const signedAttemptId: string = signed.id;
    expect(signedTxHash).toMatch(/^0x[0-9a-f]{64}$/);

    // The recovered txHash must be exactly keccak256 of the stored (encrypted-at-rest) raw tx.
    const rawTxHex = normalizeHex(decryptRawTransaction(RAW_TX_ENCRYPTION_KEY, signed.ct));
    expect(keccak256(rawTxHex)).toBe(signedTxHash);

    // --- crash: no graceful shutdown ---
    await killHard(serverA);

    // Durability: the SIGNED attempt and its ciphertext outlive the killed process.
    const afterKill = await readAttempt(operationId);
    expect(afterKill.status).toBe('SIGNED');
    expect(afterKill.txHash).toBe(signedTxHash);
    const operationAfterKill = await readOperationStatus(operationId);
    expect(operationAfterKill).not.toBe(OperationStatus.ONCHAIN_CONFIRMED);
    expect(operationAfterKill).not.toBe(OperationStatus.COMPLETED);

    // --- process B: no pause hook — must recover the SIGNED attempt ---
    serverB = startServer('B', {});
    await waitForReady(serverB);

    // Drive confirmations while B's workers broadcast + confirm.
    const confirmedStatus = await pollForOperation(
      operationId,
      (status) => status === OperationStatus.ONCHAIN_CONFIRMED || status === OperationStatus.COMPLETED,
      120_000,
      async () => {
        await rpc('evm_mine');
      },
    );
    expect([OperationStatus.ONCHAIN_CONFIRMED, OperationStatus.COMPLETED]).toContain(confirmedStatus);

    // Recovery re-broadcast the *stored* tx: same attempt row, same txHash — not a re-sign.
    const recovered = await readAttempt(operationId);
    expect(recovered.id).toBe(signedAttemptId);
    expect(recovered.txHash).toBe(signedTxHash);
    expect(['BROADCAST', 'CONFIRMED']).toContain(recovered.status);

    // And that txHash is really on-chain now.
    const receipt = (await rpc('eth_getTransactionReceipt', [signedTxHash])) as { status?: string } | null;
    expect(receipt).not.toBeNull();
    expect(receipt?.status).toBe('0x1');

    await killHard(serverB);
  }, 280_000);

  // --- helpers bound to the shared dataSource ---

  interface AttemptRow {
    id: string;
    status: string;
    txHash: string;
    ct: string;
  }

  async function readAttempt(operationId: string): Promise<AttemptRow> {
    const rows: Array<{ id: string; status: string; txHash: string; ct: string | null }> =
      await dataSource.query(
        `SELECT id, status, tx_hash AS txHash, raw_transaction_ciphertext AS ct
           FROM transaction_attempts
          WHERE operation_id = ?
          ORDER BY attempt_no DESC
          LIMIT 1`,
        [operationId],
      );
    if (rows.length === 0) throw new Error(`no transaction_attempts row for operation ${operationId}`);
    return { ...rows[0]!, ct: rows[0]!.ct ?? '' };
  }

  async function pollForAttempt(
    operationId: string,
    predicate: (row: AttemptRow) => boolean,
    timeoutMs: number,
  ): Promise<AttemptRow> {
    const deadline = Date.now() + timeoutMs;
    let last = 'none';
    while (Date.now() < deadline) {
      try {
        const row = await readAttempt(operationId);
        last = row.status;
        if (predicate(row)) return row;
      } catch {
        // row not created yet
      }
      await sleep(750);
    }
    throw new Error(`attempt for ${operationId} never matched (last status: ${last})\n${serverA?.log()}`);
  }

  async function readOperationStatus(operationId: string): Promise<OperationStatus> {
    const rows: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM operations WHERE id = ? LIMIT 1',
      [operationId],
    );
    if (rows.length === 0) throw new Error(`operation ${operationId} not found`);
    return rows[0]!.status as OperationStatus;
  }

  async function pollForOperation(
    operationId: string,
    predicate: (status: OperationStatus) => boolean,
    timeoutMs: number,
    onTick: () => Promise<void>,
  ): Promise<OperationStatus> {
    const deadline = Date.now() + timeoutMs;
    let last: OperationStatus | 'none' = 'none';
    while (Date.now() < deadline) {
      last = await readOperationStatus(operationId);
      if (predicate(last)) return last;
      if (last === OperationStatus.FAILED || last === OperationStatus.REVIEW_REQUIRED) {
        throw new Error(`operation ${operationId} reached terminal ${last}\n${serverB?.log()}`);
      }
      await onTick();
      await sleep(1000);
    }
    throw new Error(`operation ${operationId} never matched (last status: ${last})\n${serverB?.log()}`);
  }
});

function normalizeHex(hex: string): string {
  return hex.startsWith('0x') ? hex : `0x${hex}`;
}
