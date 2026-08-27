import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Query values as Express's `req.query` provides them: a string, repeated-key array, or (rarely)
 * nested objects, which this signer treats as opaque and stringifies the same way on both sides. */
export type QueryValue = string | string[] | undefined;

export interface CanonicalRequestInput {
  method: string;
  /** Path only, no query string (e.g. `req.path`). */
  path: string;
  query: Record<string, QueryValue>;
  /** Exactly the header value, not a re-serialized number — the canonical string is built from
   * the bytes the sender actually signed. */
  timestamp: string;
  nonce: string;
  rawBody: Buffer;
}

/** Normalizes `path?query` with query keys (and repeated values) sorted, so the same logical
 * request always canonicalizes identically regardless of query parameter order. */
export function normalizePathWithSortedQuery(path: string, query: Record<string, QueryValue>): string {
  const params: Array<[string, string]> = [];
  for (const key of Object.keys(query).sort()) {
    const value = query[key];
    if (value === undefined) {
      continue;
    }
    const values = Array.isArray(value) ? [...value].sort() : [value];
    for (const v of values) {
      params.push([key, v]);
    }
  }

  if (params.length === 0) {
    return path;
  }

  const queryString = params
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
  return `${path}?${queryString}`;
}

export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Builds the exact newline-joined string both sides sign: uppercase method, normalized
 * path+sorted query, Unix timestamp, nonce, lowercase hex SHA-256 of the raw request body (HMAC
 * 규칙, TASK-06 §5). */
export function buildCanonicalString(input: CanonicalRequestInput): string {
  const normalizedPath = normalizePathWithSortedQuery(input.path, input.query);
  const bodyHash = sha256Hex(input.rawBody);
  return [input.method.toUpperCase(), normalizedPath, input.timestamp, input.nonce, bodyHash].join('\n');
}

export function computeHmacSignatureHex(secret: Buffer, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/** Constant-time hex string comparison. Returns `false` (never throws) on a length mismatch,
 * instead of letting `timingSafeEqual`'s `RangeError` leak a length-based timing signal. */
export function safeCompareHex(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'hex');
  const bufferB = Buffer.from(b, 'hex');
  if (bufferA.length === 0 || bufferA.length !== bufferB.length) {
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}
