import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { OperationStatus } from '../src/shared/domain/operation-status.enum';
import { OperationType } from '../src/shared/domain/operation-type.enum';
import {
  APPROVAL_JWT_AUDIENCE,
  APPROVAL_JWT_ISSUER,
  APPROVAL_JWT_SECRET,
  applyE2eTestEnv,
  HMAC_KEY_ID,
  HMAC_SECRET,
} from './helpers/e2e-env';
import { signHmacRequest } from './helpers/hmac-sign';
import { signApprovalJwt } from './helpers/jwt-sign';

const MINTS_PATH = '/internal/v1/mints';
const WALLETS_PATH = '/internal/v1/wallets';
// Any well-formed address works as the "wrong purpose"/claim-mismatch tests' JWT `to` — those
// requests are rejected before MintApplication ever resolves a wallet, so it never needs to be a
// real provisioned wallet.
const PLACEHOLDER_ADDRESS = '0x1111111111111111111111111111111111111111';

interface MintBody {
  idempotencyKey: string;
  userId: string;
  cubeId: string;
  tokenId: number;
}

/** Asset locks now persist across test runs against the same (persistent, not-per-run-fresh) test
 * DB unless something confirms/releases them (TASK-07/11) — nothing does in this HTTP-only e2e
 * suite. Random tokenIds instead of hardcoded ones keep runs independent of each other, the same
 * way the TASK-10/11 integration suites already do. */
function randomTokenId(): number {
  return Math.floor(Math.random() * 9000) + 1;
}

function buildMintClaims(body: MintBody, to: string, overrides: Record<string, unknown> = {}) {
  return {
    jti: randomUUID(),
    purpose: OperationType.MINT,
    tokenId: body.tokenId,
    userId: body.userId,
    cubeId: body.cubeId,
    to,
    ...overrides,
  };
}

describe('POST /internal/v1/mints + GET /internal/v1/operations/:id (e2e)', () => {
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    applyE2eTestEnv();
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = originalEnv;
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function post(bodyString: string, hmacHeaders: Record<string, string>, bearer?: string) {
    const req = request(server()).post(MINTS_PATH).set('Content-Type', 'application/json').set(hmacHeaders);
    if (bearer) {
      req.set('Authorization', `Bearer ${bearer}`);
    }
    return req.send(bodyString);
  }

  function hmacFor(
    bodyString: string,
    overrides: Partial<Parameters<typeof signHmacRequest>[0]> & { path?: string } = {},
  ) {
    return signHmacRequest({
      method: 'POST',
      path: MINTS_PATH,
      bodyString,
      keyId: HMAC_KEY_ID,
      secret: HMAC_SECRET,
      ...overrides,
    });
  }

  /** Provisions (or looks up) the real custodial wallet for `userId` via the actual HTTP endpoint
   * (TASK-05), so mint tests use a `to` claim that will genuinely match what `MintApplication`
   * resolves — exercising the real TASK-07 wallet cross-check instead of a hardcoded address. */
  async function walletAddressFor(userId: string): Promise<string> {
    const bodyString = JSON.stringify({ userId });
    const response = await request(server())
      .post(WALLETS_PATH)
      .set('Content-Type', 'application/json')
      .set(hmacFor(bodyString, { path: WALLETS_PATH }))
      .send(bodyString);
    if (response.status !== 200) {
      throw new Error(
        `Failed to provision test wallet for ${userId}: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return (response.body as { address: string }).address;
  }

  function jwtFor(body: MintBody, to: string, claimOverrides: Record<string, unknown> = {}) {
    return signApprovalJwt({
      claims: buildMintClaims(body, to, claimOverrides),
      secret: APPROVAL_JWT_SECRET,
      issuer: APPROVAL_JWT_ISSUER,
      audience: APPROVAL_JWT_AUDIENCE,
    });
  }

  it('accepts a fully valid request with 202 and REQUESTED status, then it is readable via GET', async () => {
    const tokenId = randomTokenId();
    const body: MintBody = { idempotencyKey: randomUUID(), userId: 'user-1', cubeId: 'cube-1', tokenId };
    const bodyString = JSON.stringify(body);
    const token = jwtFor(body, await walletAddressFor(body.userId));

    const response = await post(bodyString, hmacFor(bodyString), token);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      status: OperationStatus.REQUESTED,
      type: OperationType.MINT,
      tokenId,
    });
    const operationId = (response.body as { operationId: string }).operationId;

    const getResponse = await request(server())
      .get(`/internal/v1/operations/${operationId}`)
      .set(hmacFor('', { method: 'GET', path: `/internal/v1/operations/${operationId}` }));
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toMatchObject({ operationId, status: OperationStatus.REQUESTED, tokenId });
  });

  it('GET a non-existent operation id returns 404 with a stable error code', async () => {
    const id = randomUUID();
    const response = await request(server())
      .get(`/internal/v1/operations/${id}`)
      .set(hmacFor('', { method: 'GET', path: `/internal/v1/operations/${id}` }));
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'OPERATION_NOT_FOUND' });
    expect(response.body).toHaveProperty('requestId');
  });

  it('rejects a request missing HMAC headers', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-2',
      cubeId: 'cube-2',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const response = await request(server())
      .post(MINTS_PATH)
      .set('Content-Type', 'application/json')
      .send(bodyString);
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HMAC_MISSING_HEADERS' });
  });

  it('rejects a tampered signature', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-3',
      cubeId: 'cube-3',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const headers = hmacFor(bodyString);
    const originalSignature = headers['X-ARZONE-Signature'] ?? '';
    headers['X-ARZONE-Signature'] = originalSignature.startsWith('f')
      ? originalSignature.replace(/^f/, 'e')
      : `f${originalSignature.slice(1)}`;

    const response = await post(bodyString, headers, jwtFor(body, PLACEHOLDER_ADDRESS));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HMAC_SIGNATURE_MISMATCH' });
  });

  it('rejects an expired timestamp', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-4',
      cubeId: 'cube-4',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const headers = hmacFor(bodyString, { timestamp: Math.floor(Date.now() / 1000) - 400 });

    const response = await post(bodyString, headers, jwtFor(body, PLACEHOLDER_ADDRESS));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HMAC_TIMESTAMP_OUT_OF_RANGE' });
  });

  it('rejects a timestamp too far in the future', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-5',
      cubeId: 'cube-5',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const headers = hmacFor(bodyString, { timestamp: Math.floor(Date.now() / 1000) + 400 });

    const response = await post(bodyString, headers, jwtFor(body, PLACEHOLDER_ADDRESS));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HMAC_TIMESTAMP_OUT_OF_RANGE' });
  });

  it('rejects a replayed (nonce, timestamp) pair even for an identical request', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-6',
      cubeId: 'cube-6',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const headers = hmacFor(bodyString);
    const token = jwtFor(body, await walletAddressFor(body.userId));

    const first = await post(bodyString, headers, token);
    expect(first.status).toBe(202);

    const replay = await post(bodyString, headers, token);
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: 'HMAC_NONCE_REPLAYED' });
  });

  it('rejects a missing approval token', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-7',
      cubeId: 'cube-7',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const response = await post(bodyString, hmacFor(bodyString));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'APPROVAL_JWT_MISSING' });
  });

  it('rejects an approval token issued for a different purpose', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-8',
      cubeId: 'cube-8',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const wrongPurposeToken = signApprovalJwt({
      claims: {
        jti: randomUUID(),
        purpose: OperationType.TRANSFER,
        tokenId: body.tokenId,
        tradeId: 'trade-1',
        sellerUserId: 'seller',
        buyerUserId: 'buyer',
        from: PLACEHOLDER_ADDRESS,
        to: PLACEHOLDER_ADDRESS,
      },
      secret: APPROVAL_JWT_SECRET,
      issuer: APPROVAL_JWT_ISSUER,
      audience: APPROVAL_JWT_AUDIENCE,
    });

    const response = await post(bodyString, hmacFor(bodyString), wrongPurposeToken);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'APPROVAL_JWT_PURPOSE_MISMATCH' });
  });

  it('rejects an approval token whose claims do not match the request body', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-9',
      cubeId: 'cube-9',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const mismatchedToken = jwtFor(body, PLACEHOLDER_ADDRESS, { tokenId: 999 });

    const response = await post(bodyString, hmacFor(bodyString), mismatchedToken);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'APPROVAL_CLAIM_MISMATCH' });
  });

  it('an exact idempotent resend (same key, same content, fresh approval) returns the same Operation', async () => {
    const body: MintBody = {
      idempotencyKey: randomUUID(),
      userId: 'user-10',
      cubeId: 'cube-10',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);
    const walletAddress = await walletAddressFor(body.userId);

    const first = await post(bodyString, hmacFor(bodyString), jwtFor(body, walletAddress));
    expect(first.status).toBe(202);

    const second = await post(bodyString, hmacFor(bodyString), jwtFor(body, walletAddress));
    expect(second.status).toBe(202);

    expect((second.body as { operationId: string }).operationId).toBe(
      (first.body as { operationId: string }).operationId,
    );
  });

  it('reusing the same idempotencyKey with different content is a 409 conflict', async () => {
    const idempotencyKey = randomUUID();
    const walletAddress = await walletAddressFor('user-11');
    const first: MintBody = {
      idempotencyKey,
      userId: 'user-11',
      cubeId: 'cube-11',
      tokenId: randomTokenId(),
    };
    const firstBodyString = JSON.stringify(first);
    const firstResponse = await post(firstBodyString, hmacFor(firstBodyString), jwtFor(first, walletAddress));
    expect(firstResponse.status).toBe(202);

    const second: MintBody = {
      idempotencyKey,
      userId: 'user-11',
      cubeId: 'cube-11',
      tokenId: randomTokenId(),
    };
    const secondBodyString = JSON.stringify(second);
    const secondResponse = await post(
      secondBodyString,
      hmacFor(secondBodyString),
      jwtFor(second, walletAddress),
    );

    expect(secondResponse.status).toBe(409);
    expect(secondResponse.body).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
