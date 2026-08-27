import { randomUUID } from 'node:crypto';

import { buildCanonicalString, computeHmacSignatureHex } from '../../src/shared/auth/hmac/canonical-request';

export interface SignHmacRequestInput {
  method: string;
  /** No query string. */
  path: string;
  query?: Record<string, string>;
  /** Exact bytes that will be sent as the request body — callers must send this same string
   * verbatim (e.g. via supertest `.send(bodyString)` with an explicit JSON content-type), not a
   * re-serialized object, or the signature won't match what the server hashes. */
  bodyString: string;
  keyId: string;
  secret: Buffer;
  timestamp?: number;
  nonce?: string;
}

/** A plain string-keyed record (not a narrower literal-key type) so it can be passed directly to
 * supertest's `.set(headers)`, which expects `Record<string, string>`. */
export type SignedHmacHeaders = Record<string, string>;

/** Builds a valid, correctly-signed HMAC header set for a test request — the same canonical
 * construction `HmacGuard` verifies against, so tests exercise the real signing contract instead
 * of a shortcut. */
export function signHmacRequest(input: SignHmacRequestInput): SignedHmacHeaders {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomUUID();
  const rawBody = Buffer.from(input.bodyString, 'utf8');

  const canonical = buildCanonicalString({
    method: input.method,
    path: input.path,
    query: input.query ?? {},
    timestamp: String(timestamp),
    nonce,
    rawBody,
  });
  const signature = computeHmacSignatureHex(input.secret, canonical);

  return {
    'X-ARZONE-Key-Id': input.keyId,
    'X-ARZONE-Timestamp': String(timestamp),
    'X-ARZONE-Nonce': nonce,
    'X-ARZONE-Signature': signature,
  };
}
