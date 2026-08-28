import { describeRpcError, redactHexBlobs, summarizeRpcError } from './rpc-error';

/** A realistic EIP-1559 signed raw transaction shape (type 0x02, long RLP) — the exact thing ethers
 * echoes back inside `eth_sendRawTransaction` error messages (검증 D11). */
const FAKE_RAW_TX = `0x02f9${'ab'.repeat(180)}`;

function ethersLikeBroadcastError(message: string): Error {
  // ethers v6 shape: outer message embeds the JSON-RPC request payload, nested error carries the
  // node's own message.
  const error = new Error(
    `could not coalesce error (error={ "code": -32000, "data": { "message": "${message}" }, "message": "${message}" }, payload={ "id": 7, "jsonrpc": "2.0", "method": "eth_sendRawTransaction", "params": [ "${FAKE_RAW_TX}" ] }, code=UNKNOWN_ERROR, version=6.17.0)`,
  ) as Error & { code: string; error: { code: number; message: string } };
  error.code = 'UNKNOWN_ERROR';
  error.error = { code: -32000, message };
  return error;
}

describe('rpc-error (검증 D1 classification / D11 redaction)', () => {
  it('never lets a signed raw transaction survive into the summary', () => {
    const summary = summarizeRpcError(
      ethersLikeBroadcastError('Nonce too high. Expected nonce to be 7 but got 8.'),
    );
    expect(summary.reason).not.toContain(FAKE_RAW_TX);
    expect(summary.reason).not.toMatch(/0x[0-9a-fA-F]{67,}/u);
    expect(describeRpcError(ethersLikeBroadcastError('x'))).not.toContain('params');
  });

  it('classifies nonce too high as a signer gap', () => {
    const summary = summarizeRpcError(
      ethersLikeBroadcastError('Nonce too high. Expected nonce to be 7 but got 8.'),
    );
    expect(summary.class).toBe('NONCE_TOO_HIGH');
    expect(summary.reason).toContain('Nonce too high');
  });

  it('classifies nonce too low / already known as idempotent success', () => {
    expect(summarizeRpcError(ethersLikeBroadcastError('nonce too low')).class).toBe('NONCE_TOO_LOW');
    expect(summarizeRpcError(ethersLikeBroadcastError('already known')).class).toBe('ALREADY_KNOWN');
  });

  it('classifies deterministic rejects as permanent', () => {
    expect(
      summarizeRpcError(ethersLikeBroadcastError('insufficient funds for gas * price + value')).class,
    ).toBe('INSUFFICIENT_FUNDS');
    expect(summarizeRpcError(ethersLikeBroadcastError('intrinsic gas too low')).class).toBe(
      'PERMANENT_REJECT',
    );
    expect(summarizeRpcError(ethersLikeBroadcastError('replacement transaction underpriced')).class).toBe(
      'PERMANENT_REJECT',
    );
  });

  it('classifies a revert via the ethers CALL_EXCEPTION code', () => {
    const error = Object.assign(new Error('execution reverted (unknown custom error)'), {
      code: 'CALL_EXCEPTION',
      data: '0x055e54d1',
    });
    expect(summarizeRpcError(error).class).toBe('REVERT');
    expect(summarizeRpcError(error).code).toBe('CALL_EXCEPTION');
  });

  it('treats anything unrecognised (network, timeout, 5xx) as transient', () => {
    expect(summarizeRpcError(Object.assign(new Error('fetch failed'), { code: 'NETWORK_ERROR' })).class).toBe(
      'TRANSIENT',
    );
    expect(summarizeRpcError(new Error('socket hang up')).class).toBe('TRANSIENT');
    expect(summarizeRpcError('weird non-error').class).toBe('TRANSIENT');
  });

  it('redactHexBlobs keeps hashes/addresses but strips long hex and payload echoes', () => {
    const hash = `0x${'1'.repeat(64)}`;
    const address = `0x${'2'.repeat(40)}`;
    const text = `tx ${hash} from ${address} raw ${FAKE_RAW_TX} (request={"params":["${FAKE_RAW_TX}"]})`;
    const redacted = redactHexBlobs(text, 1000);
    expect(redacted).toContain(hash);
    expect(redacted).toContain(address);
    expect(redacted).not.toContain(FAKE_RAW_TX);
    expect(redacted).not.toContain('request=');
  });

  it('caps the reason length', () => {
    const long = 'x'.repeat(5000);
    expect(summarizeRpcError(new Error(long)).reason.length).toBeLessThanOrEqual(200);
  });
});
