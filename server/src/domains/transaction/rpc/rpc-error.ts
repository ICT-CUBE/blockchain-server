/**
 * Classification + redaction of JSON-RPC / ethers errors (검증 D1 §6, D11).
 *
 * Two problems this solves:
 *
 * 1. ethers embeds the full JSON-RPC request — including `eth_sendRawTransaction`'s signed raw
 *    transaction hex — in `error.message`. Logging that verbatim leaks signed transactions,
 *    calldata and owner signatures into log aggregation (명세 §15 금지 항목). `summarizeRpcError`
 *    returns only a short, allowlisted `{ class, code, reason }` with every long hex blob and
 *    request payload stripped; `redactHexBlobs` is the underlying scrubber for any message that
 *    might carry chain payloads.
 * 2. Broadcast/recovery need to react differently to "nonce too high" (a signer-level gap),
 *    "already known" (success), a deterministic reject (never retry) and a transient network error
 *    (retry with backoff) — `class` is that decision, computed in one place.
 */

export type RpcErrorClass =
  | 'NONCE_TOO_HIGH'
  | 'NONCE_TOO_LOW'
  | 'ALREADY_KNOWN'
  | 'INSUFFICIENT_FUNDS'
  | 'REVERT'
  | 'PERMANENT_REJECT'
  | 'TRANSIENT';

export interface RpcErrorSummary {
  class: RpcErrorClass;
  /** ethers error code (e.g. `CALL_EXCEPTION`, `SERVER_ERROR`) or the JSON-RPC numeric code as a
   * string, or `UNKNOWN`. */
  code: string;
  /** Short, redacted, human-readable reason. Never contains a hex blob longer than a hash. */
  reason: string;
}

const MAX_REASON_LENGTH = 200;

/** Replaces any `0x`-hex run longer than a 32-byte hash (66 chars) with a fixed marker, and strips
 * ethers' `request=`/`response=`/`params` payload echoes. Hashes and addresses survive untouched. */
export function redactHexBlobs(text: string, maxLength = MAX_REASON_LENGTH): string {
  const withoutPayloads = text
    // ethers v6 appends `(request={...}, response={...}, ...)` / `(error={...}, payload={...})` —
    // drop everything from the first such payload echo onwards, wherever it starts.
    .replace(/\(?\b(?:request|response|payload|error|info)=\{[\s\S]*$/u, '')
    .replace(/"params"\s*:\s*\[[\s\S]*?\]/gu, '"params":[redacted]')
    .replace(/0x[0-9a-fA-F]{67,}/gu, '[hex-redacted]');
  const collapsed = withoutPayloads.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maxLength ? `${collapsed.slice(0, maxLength - 1)}…` : collapsed;
}

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** ethers wraps the provider's JSON-RPC error several levels deep; walk the usual spots for the
 * most specific message before falling back to the outer one. */
function innermostMessage(error: unknown): string {
  if (!(typeof error === 'object' && error !== null)) {
    return String(error);
  }
  const e = error as Record<string, unknown>;
  const candidates: unknown[] = [
    (e.info as Record<string, unknown> | undefined)?.error,
    e.error,
    (e.error as Record<string, unknown> | undefined)?.data,
    e.data,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'object' && candidate !== null) {
      const message = pickString((candidate as Record<string, unknown>).message);
      if (message) {
        return message;
      }
    }
  }
  return pickString(e.shortMessage) ?? pickString(e.message) ?? 'unknown error';
}

function errorCode(error: unknown): string {
  if (!(typeof error === 'object' && error !== null)) {
    return 'UNKNOWN';
  }
  const e = error as Record<string, unknown>;
  if (typeof e.code === 'string' && e.code.length > 0) {
    return e.code;
  }
  const nested =
    (e.error as Record<string, unknown> | undefined)?.code ??
    (e.info as Record<string, unknown> | undefined)?.error;
  if (typeof nested === 'number') {
    return String(nested);
  }
  if (
    typeof nested === 'object' &&
    nested !== null &&
    typeof (nested as Record<string, unknown>).code === 'number'
  ) {
    return String((nested as Record<string, unknown>).code);
  }
  return 'UNKNOWN';
}

function classify(code: string, lowerMessage: string): RpcErrorClass {
  if (lowerMessage.includes('nonce too high') || lowerMessage.includes('nonce is too high')) {
    return 'NONCE_TOO_HIGH';
  }
  if (lowerMessage.includes('nonce too low') || lowerMessage.includes('nonce has already been used')) {
    return 'NONCE_TOO_LOW';
  }
  if (
    lowerMessage.includes('already known') ||
    lowerMessage.includes('already imported') ||
    lowerMessage.includes('known transaction') ||
    lowerMessage.includes('alreadyknown')
  ) {
    return 'ALREADY_KNOWN';
  }
  if (lowerMessage.includes('insufficient funds') || code === 'INSUFFICIENT_FUNDS') {
    return 'INSUFFICIENT_FUNDS';
  }
  if (
    code === 'CALL_EXCEPTION' ||
    lowerMessage.includes('execution reverted') ||
    lowerMessage.includes('reverted with') ||
    lowerMessage.includes('vm exception')
  ) {
    return 'REVERT';
  }
  if (
    code === 'INVALID_ARGUMENT' ||
    code === 'UNSUPPORTED_OPERATION' ||
    lowerMessage.includes('intrinsic gas too low') ||
    lowerMessage.includes('exceeds block gas limit') ||
    lowerMessage.includes('invalid sender') ||
    lowerMessage.includes('invalid signature') ||
    lowerMessage.includes('invalid transaction') ||
    lowerMessage.includes('invalid chain id') ||
    lowerMessage.includes('underpriced') ||
    lowerMessage.includes('max fee per gas less than block base fee') ||
    lowerMessage.includes('oversized data')
  ) {
    return 'PERMANENT_REJECT';
  }
  return 'TRANSIENT';
}

/** Never throws. Safe to log the returned object's fields verbatim. */
export function summarizeRpcError(error: unknown): RpcErrorSummary {
  const code = errorCode(error);
  const message = innermostMessage(error);
  const cls = classify(code, message.toLowerCase());
  return { class: cls, code, reason: redactHexBlobs(message) };
}

/** `"<class>/<code>: <reason>"` — the one-line form every transaction-domain log uses. */
export function describeRpcError(error: unknown): string {
  const summary = summarizeRpcError(error);
  return `${summary.class}/${summary.code}: ${summary.reason}`;
}
