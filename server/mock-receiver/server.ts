/**
 * TASK-12 §3/§7's Mock Receiver: stands in for Backend's real webhook endpoint during local/test
 * development, since that endpoint doesn't exist yet (TASK-12 §2). A small standalone HTTP server —
 * deliberately outside the Nest app (it simulates an *external* service, not part of this one) —
 * that verifies the same HMAC scheme `HmacGuard` verifies inbound with, accepts by `notificationId`
 * (TASK-12 §11: "중복 수신... 안전하게 수락"), and can be told to fail on-demand to exercise the
 * delivery worker's retry/backoff path.
 *
 * Run: npm run mock-receiver --workspace=server
 * Env: MOCK_RECEIVER_PORT (default 4100), MOCK_RECEIVER_HMAC_SECRET (base64url, required),
 *      MOCK_RECEIVER_FAIL_COUNT (fail this many *new* notificationIds' first delivery attempt with
 *      a 500 before accepting, default 0 — set >0 to exercise retry).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { buildCanonicalString, computeHmacSignatureHex, safeCompareHex } from '../src/shared/auth/hmac/canonical-request';

const TIMESTAMP_WINDOW_SECONDS = 300;

export interface MockReceiverOptions {
  /** Base64url — must match the server's `HMAC_OUTBOUND_KEY_SECRET`. */
  hmacSecret: Buffer;
  /** First `failCount` sightings of a *new* notificationId fail with a 500; every later delivery
   * of the same id (retry or redeliver) succeeds and is reported as a duplicate. Default 0. */
  failCount?: number;
  /** For building the canonical string's `path` from `req.url` — must match the path segment of
   * whatever `NOTIFICATION_CALLBACK_URL` the server under test is configured with. Default 4100
   * is only used to construct a base for `new URL(req.url, base)`, never actually dialed. */
  port?: number;
  onReceived?: (notificationId: string, duplicate: boolean) => void;
}

/** Builds (but does not start) the Mock Receiver's `http.Server` — importable both by the
 * standalone script below (`npm run mock-receiver`) and by TASK-12's integration tests, so both
 * exercise the identical verification/dedup/simulated-failure logic. */
export function createMockReceiverServer(options: MockReceiverOptions): Server {
  const port = options.port ?? 4100;
  /** notificationId -> number of times seen. */
  const seen = new Map<string, number>();

  function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function send(res: ServerResponse, status: number, body: Record<string, unknown>): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(json);
  }

  async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawBody = await readBody(req);

    const keyId = req.headers['x-arzone-key-id'];
    const timestamp = req.headers['x-arzone-timestamp'];
    const nonce = req.headers['x-arzone-nonce'];
    const signature = req.headers['x-arzone-signature'];
    if (
      typeof keyId !== 'string' ||
      typeof timestamp !== 'string' ||
      typeof nonce !== 'string' ||
      typeof signature !== 'string'
    ) {
      send(res, 401, { error: 'missing HMAC headers' });
      return;
    }

    const timestampSeconds = Number(timestamp);
    if (
      !Number.isInteger(timestampSeconds) ||
      Math.abs(Date.now() / 1000 - timestampSeconds) > TIMESTAMP_WINDOW_SECONDS
    ) {
      send(res, 401, { error: 'timestamp out of range' });
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const canonical = buildCanonicalString({
      method: req.method ?? 'POST',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      timestamp,
      nonce,
      rawBody,
    });
    const expectedSignature = computeHmacSignatureHex(options.hmacSecret, canonical);
    if (!safeCompareHex(signature, expectedSignature)) {
      // Never log the signature or secret — only the fact that verification failed.
      send(res, 401, { error: 'invalid signature' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      send(res, 400, { error: 'invalid JSON body' });
      return;
    }

    const notificationId = (payload as { notificationId?: unknown } | null)?.notificationId;
    if (typeof notificationId !== 'string') {
      send(res, 400, { error: 'missing notificationId' });
      return;
    }

    const priorSightings = seen.get(notificationId) ?? 0;
    seen.set(notificationId, priorSightings + 1);

    const failCount = options.failCount ?? 0;
    if (priorSightings < failCount) {
      console.log(`[mock-receiver] simulating failure for ${notificationId} (attempt ${priorSightings + 1}/${failCount})`);
      send(res, 500, { error: 'simulated failure' });
      return;
    }

    const duplicate = priorSightings > 0;
    console.log(`[mock-receiver] accepted ${notificationId}${duplicate ? ' (duplicate, still 2xx)' : ''}`);
    options.onReceived?.(notificationId, duplicate);
    send(res, 200, { received: true, duplicate });
  }

  return createServer((req, res) => {
    if (req.method === 'POST' && new URL(req.url ?? '/', `http://localhost:${port}`).pathname === '/webhook') {
      handleWebhook(req, res).catch((error: unknown) => {
        console.error('[mock-receiver] unhandled error', error);
        send(res, 500, { error: 'internal error' });
      });
      return;
    }
    send(res, 404, { error: 'not found' });
  });
}

/* eslint-disable no-console -- this branch only runs when executed directly as a CLI script */
if (require.main === module) {
  const port = Number(process.env.MOCK_RECEIVER_PORT ?? 4100);
  const hmacSecretB64Url = process.env.MOCK_RECEIVER_HMAC_SECRET;
  const failCount = Number(process.env.MOCK_RECEIVER_FAIL_COUNT ?? 0);

  if (!hmacSecretB64Url) {
    console.error("MOCK_RECEIVER_HMAC_SECRET is required (must match the server's HMAC_OUTBOUND_KEY_SECRET)");
    process.exit(1);
  }

  const server = createMockReceiverServer({
    hmacSecret: Buffer.from(hmacSecretB64Url, 'base64url'),
    failCount,
    port,
  });
  server.listen(port, () => {
    console.log(`[mock-receiver] listening on http://127.0.0.1:${port}/webhook (FAIL_COUNT=${failCount})`);
  });
}
/* eslint-enable no-console */
