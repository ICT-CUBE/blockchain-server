import { Wallet } from 'ethers';

import { scanText } from '../../scripts/scan-sensitive';
import { describeRpcError, redactHexBlobs } from '../../src/domains/transaction/rpc/rpc-error';
import { redactSensitiveKeys } from '../../src/shared/logging/sensitive-key-redactor';
import { StructuredLogger } from '../../src/shared/logging/structured-logger';

/**
 * 검증 계획서 T14-01 / TASK-14 §5·§9 as an executable, repeatable check (검증 개선안 §13): a corpus of
 * material that must never reach durable storage or logs is pushed through every redaction layer
 * and the multi-rule scanner (`scripts/scan-sensitive.ts`) must find nothing on the output — while
 * still catching each item when it *is* present (so the scanner itself is proven, not assumed).
 */
describe('nonfunctional: sensitive-material redaction and scanner', () => {
  const wallet = new Wallet('0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'); // hardhat #5, public
  let signedRawTx: string;
  let ownerSignature: string;
  const jwt =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.abcdefghijklmnopqrstuvwxyz0123456789';
  const hmacSecret = 'ZmFrZS1zZWNyZXQtdmFsdWUtdGhhdC1pcy1sb25nLWVub3VnaA';

  beforeAll(async () => {
    signedRawTx = await wallet.signTransaction({
      to: wallet.address,
      value: 0n,
      nonce: 7,
      chainId: 31337,
      gasLimit: 21000n,
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      type: 2,
      data: '0x',
    });
    ownerSignature = await wallet.signMessage('consent');
  });

  it('the scanner catches every corpus item when present (positive control)', () => {
    const corpus = [
      `raw: ${signedRawTx}`,
      `sig: ${ownerSignature}`,
      `jwt: ${jwt}`,
      `echo: could not coalesce error (payload={ "params": [ "${signedRawTx}" ] })`,
      `key: ${wallet.privateKey}`,
    ].join('\n');
    const findings = scanText('corpus', corpus, [hmacSecret]);
    const rules = new Set(findings.map((f) => f.rule));
    expect(rules.has('RAW_TX_TYPED')).toBe(true);
    expect(rules.has('SIGNATURE_65B')).toBe(true);
    expect(rules.has('JWT')).toBe(true);
    expect(rules.has('RPC_PAYLOAD_ECHO')).toBe(true);
    expect(rules.has('POSSIBLE_KEY_32B')).toBe(true);
  });

  it('the scanner does not flag ordinary hashes and addresses (negative control)', () => {
    const benign = `txHash=0x${'ab'.repeat(32)} blockHash: 0x${'cd'.repeat(32)} owner 0x${'12'.repeat(20)} nonce 25`;
    expect(scanText('benign', benign, [])).toEqual([]);
  });

  it('describeRpcError strips a signed raw transaction embedded in an ethers broadcast error', () => {
    const error = Object.assign(
      new Error(
        `could not coalesce error (error={ "code": -32000, "message": "Nonce too high" }, payload={ "params": [ "${signedRawTx}" ] })`,
      ),
      {
        code: 'UNKNOWN_ERROR',
        error: { code: -32000, message: 'Nonce too high. Expected nonce to be 7 but got 8.' },
      },
    );
    const described = describeRpcError(error);
    expect(scanText('described', described, [])).toEqual([]);
    expect(described).toContain('NONCE_TOO_HIGH');
  });

  it('StructuredLogger output for a redacted message contains no corpus material', () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      const logger = new StructuredLogger('log');
      logger.warn(
        `Broadcast failed: ${redactHexBlobs(`payload={"params":["${signedRawTx}"]} sig ${ownerSignature}`)}`,
        'Test',
      );
    } finally {
      process.stdout.write = original;
    }
    expect(scanText('logger', chunks.join(''), [hmacSecret])).toEqual([]);
  });

  it('AuditWriter-style key redaction removes signature/secret/key-named values', () => {
    const redacted = redactSensitiveKeys(
      {
        externalSignature: ownerSignature,
        privateKey: wallet.privateKey,
        hmacSecret,
        nested: { authorization: `Bearer ${jwt}`, ok: 'value', txHash: `0x${'ab'.repeat(32)}` },
      },
      () => undefined,
    ) as Record<string, unknown>;
    expect(scanText('audit', JSON.stringify(redacted), [hmacSecret])).toEqual([]);
    expect((redacted.nested as Record<string, unknown>).txHash).toBe(`0x${'ab'.repeat(32)}`);
  });
});
