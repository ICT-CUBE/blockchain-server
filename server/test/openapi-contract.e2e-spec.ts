import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { OperationType } from '../src/shared/domain/operation-type.enum';
import {
  APPROVAL_JWT_AUDIENCE,
  APPROVAL_JWT_ISSUER,
  APPROVAL_JWT_SECRET,
  applyE2eTestEnv,
  HMAC_KEY_ID,
  HMAC_OPERATOR_KEY_ID,
  HMAC_OPERATOR_SECRET,
  HMAC_SECRET,
} from './helpers/e2e-env';
import { signHmacRequest } from './helpers/hmac-sign';
import { signApprovalJwt } from './helpers/jwt-sign';
import { OPENAPI_PATH, OpenApiValidator } from './helpers/openapi-validator';

const PNG_BASE64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(16, 7),
]).toString('base64');

function randomTokenId(): number {
  return Math.floor(Math.random() * 9000) + 1;
}

/**
 * 검증 개선안 §4 / 계획서 T15 §4: every documented endpoint's real response is validated against
 * the repo-root `openapi.yaml`. This suite boots the whole HTTP stack but does not need a chain — it exercises
 * the accept/lookup/error paths (the on-chain lifecycle is covered by the integration suites) and, for
 * the one endpoint that reads the chain (`GET /nfts/{tokenId}`), accepts either the documented 200 or
 * the documented 503 — both must validate.
 */
describe('OpenAPI contract (e2e)', () => {
  let app: INestApplication;
  let validator: OpenApiValidator;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    // The spec is a versioned repo file (`code/openapi.yaml`). If it is ever missing this suite
    // MUST fail loudly — a silent skip here is exactly what let 8 hollow "passing" tests hide a
    // stale/misplaced spec (검증 피드백 2026-08-28).
    if (!existsSync(OPENAPI_PATH)) {
      throw new Error(
        `OpenAPI contract suite cannot run: spec not found at ${OPENAPI_PATH}. ` +
          'It is a versioned file — restore code/openapi.yaml.',
      );
    }
    applyE2eTestEnv();
    validator = new OpenApiValidator();
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    process.env = originalEnv;
  });

  function server(): Server {
    return app.getHttpServer() as Server;
  }

  function inbound(method: string, urlPath: string, bodyString = '') {
    const url = new URL(urlPath, 'http://localhost');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return signHmacRequest({
      method,
      path: url.pathname,
      query,
      bodyString,
      keyId: HMAC_KEY_ID,
      secret: HMAC_SECRET,
    });
  }

  function operator(method: string, urlPath: string, bodyString = '') {
    const url = new URL(urlPath, 'http://localhost');
    const query: Record<string, string> = {};
    url.searchParams.forEach((v, k) => {
      query[k] = v;
    });
    return signHmacRequest({
      method,
      path: url.pathname,
      query,
      bodyString,
      keyId: HMAC_OPERATOR_KEY_ID,
      secret: HMAC_OPERATOR_SECRET,
    });
  }

  async function post(urlPath: string, body: unknown, headers: Record<string, string>) {
    const bodyString = JSON.stringify(body);
    return request(server())
      .post(urlPath)
      .set('Content-Type', 'application/json')
      .set(headers)
      .set(headers.Authorization ? {} : {})
      .send(bodyString);
  }

  it('health / ready', async () => {
    const health = await request(server()).get('/health');
    validator.assertResponse('get', '/health', health.status, health.body);
    const ready = await request(server()).get('/ready');
    validator.assertResponse('get', '/ready', ready.status, ready.body);
  });

  it('wallets: ensure, get, 404, 401', async () => {
    const userId = `contract-${randomUUID()}`;
    const body = { userId };
    validator.assertRequestBody('post', '/internal/v1/wallets', body);
    const created = await post(
      '/internal/v1/wallets',
      body,
      inbound('POST', '/internal/v1/wallets', JSON.stringify(body)),
    );
    expect(created.status).toBe(200);
    validator.assertResponse('post', '/internal/v1/wallets', 200, created.body);

    const found = await request(server())
      .get(`/internal/v1/wallets/${userId}`)
      .set(inbound('GET', `/internal/v1/wallets/${userId}`));
    validator.assertResponse('get', '/internal/v1/wallets/{userId}', found.status, found.body);

    const missing = await request(server())
      .get('/internal/v1/wallets/nobody-here')
      .set(inbound('GET', '/internal/v1/wallets/nobody-here'));
    expect(missing.status).toBe(404);
    validator.assertResponse('get', '/internal/v1/wallets/{userId}', 404, missing.body);

    const unauth = await request(server()).get(`/internal/v1/wallets/${userId}`);
    expect(unauth.status).toBe(401);
    validator.assertResponse('get', '/internal/v1/wallets/{userId}', 401, unauth.body);
  });

  it('nfts: documented 200 or 503, and 400 for an out-of-range tokenId', async () => {
    const response = await request(server())
      .get('/internal/v1/nfts/421')
      .set(inbound('GET', '/internal/v1/nfts/421'));
    expect([200, 503]).toContain(response.status);
    validator.assertResponse('get', '/internal/v1/nfts/{tokenId}', response.status, response.body);

    const bad = await request(server())
      .get('/internal/v1/nfts/10001')
      .set(inbound('GET', '/internal/v1/nfts/10001'));
    expect(bad.status).toBe(400);
    validator.assertResponse('get', '/internal/v1/nfts/{tokenId}', 400, bad.body);
  });

  it('metadata: prepare (200), status (200), PII field rejected (400), non-image rejected (415)', async () => {
    const tokenId = randomTokenId();
    const body = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'GOLD',
      imageBase64: PNG_BASE64,
      imageMimeType: 'image/png',
      benefitReferenceId: `benefit-${tokenId}`,
    };
    validator.assertRequestBody('post', '/internal/v1/metadata', body);
    const prepared = await post(
      '/internal/v1/metadata',
      body,
      inbound('POST', '/internal/v1/metadata', JSON.stringify(body)),
    );
    expect(prepared.status).toBe(200);
    validator.assertResponse('post', '/internal/v1/metadata', 200, prepared.body);

    const status = await request(server())
      .get(`/internal/v1/metadata/${tokenId}`)
      .set(inbound('GET', `/internal/v1/metadata/${tokenId}`));
    expect(status.status).toBe(200);
    validator.assertResponse('get', '/internal/v1/metadata/{tokenId}', 200, status.body);

    const pii = { ...body, userId: 'leak' };
    const rejected = await post(
      '/internal/v1/metadata',
      pii,
      inbound('POST', '/internal/v1/metadata', JSON.stringify(pii)),
    );
    expect(rejected.status).toBe(400);
    validator.assertResponse('post', '/internal/v1/metadata', 400, rejected.body);

    const notImage = { ...body, imageBase64: Buffer.from('definitely not an image').toString('base64') };
    delete (notImage as { imageMimeType?: string }).imageMimeType;
    const unsupported = await post(
      '/internal/v1/metadata',
      notImage,
      inbound('POST', '/internal/v1/metadata', JSON.stringify(notImage)),
    );
    expect(unsupported.status).toBe(415);
    validator.assertResponse('post', '/internal/v1/metadata', 415, unsupported.body);
  });

  it('mints + operations: 202 accepted, GET view, cancel, 404, 409', async () => {
    const tokenId = randomTokenId();
    const userId = `contract-mint-${randomUUID()}`;
    const walletBody = JSON.stringify({ userId });
    const wallet = await post(
      '/internal/v1/wallets',
      { userId },
      inbound('POST', '/internal/v1/wallets', walletBody),
    );
    const metaBody = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: PNG_BASE64,
      benefitReferenceId: `b-${tokenId}`,
    };
    await post(
      '/internal/v1/metadata',
      metaBody,
      inbound('POST', '/internal/v1/metadata', JSON.stringify(metaBody)),
    );

    const mint = { idempotencyKey: randomUUID(), userId, cubeId: `cube-${tokenId}`, tokenId };
    validator.assertRequestBody('post', '/internal/v1/mints', mint);
    const token = signApprovalJwt({
      claims: {
        jti: randomUUID(),
        purpose: OperationType.MINT,
        tokenId,
        userId,
        cubeId: mint.cubeId,
        to: (wallet.body as { address: string }).address,
      },
      secret: APPROVAL_JWT_SECRET,
      issuer: APPROVAL_JWT_ISSUER,
      audience: APPROVAL_JWT_AUDIENCE,
    });
    const mintBody = JSON.stringify(mint);
    const accepted = await request(server())
      .post('/internal/v1/mints')
      .set('Content-Type', 'application/json')
      .set(inbound('POST', '/internal/v1/mints', mintBody))
      .set('Authorization', `Bearer ${token}`)
      .send(mintBody);
    expect(accepted.status).toBe(202);
    validator.assertResponse('post', '/internal/v1/mints', 202, accepted.body);
    const operationId = (accepted.body as { operationId: string }).operationId;

    const view = await request(server())
      .get(`/internal/v1/operations/${operationId}`)
      .set(inbound('GET', `/internal/v1/operations/${operationId}`));
    expect(view.status).toBe(200);
    validator.assertResponse('get', '/internal/v1/operations/{operationId}', 200, view.body);
    expect(view.body).toMatchObject({
      operationId,
      idempotencyKey: mint.idempotencyKey,
      txAttempts: [],
      notification: null,
    });

    const cancelBody = JSON.stringify({ reason: 'contract test' });
    const cancelled = await request(server())
      .post(`/internal/v1/operations/${operationId}/cancel`)
      .set('Content-Type', 'application/json')
      .set(inbound('POST', `/internal/v1/operations/${operationId}/cancel`, cancelBody))
      .send(cancelBody);
    expect([200, 409]).toContain(cancelled.status); // 409 only if a worker submitted it first
    validator.assertResponse(
      'post',
      '/internal/v1/operations/{operationId}/cancel',
      cancelled.status,
      cancelled.body,
    );

    const missing = randomUUID();
    const notFound = await request(server())
      .get(`/internal/v1/operations/${missing}`)
      .set(inbound('GET', `/internal/v1/operations/${missing}`));
    expect(notFound.status).toBe(404);
    validator.assertResponse('get', '/internal/v1/operations/{operationId}', 404, notFound.body);

    const missingJwt = await request(server())
      .post('/internal/v1/mints')
      .set('Content-Type', 'application/json')
      .set(inbound('POST', '/internal/v1/mints', mintBody))
      .send(mintBody);
    expect(missingJwt.status).toBe(401);
    validator.assertResponse('post', '/internal/v1/mints', 401, missingJwt.body);
  });

  it('external consent challenge: 400 validation and 409 owner mismatch / 503 both documented', async () => {
    const bad = { tokenId: 1, from: 'nope', to: 'nope', purpose: 'REENTRY' };
    const invalid = await post(
      '/internal/v1/external-consent-challenges',
      bad,
      inbound('POST', '/internal/v1/external-consent-challenges', JSON.stringify(bad)),
    );
    expect(invalid.status).toBe(400);
    validator.assertResponse('post', '/internal/v1/external-consent-challenges', 400, invalid.body);
  });

  it('operator endpoints: failures/records pages validate; inbound key is 403 HMAC_SCOPE_FORBIDDEN', async () => {
    const failures = await request(server())
      .get('/internal/v1/audit/failures?page=1&pageSize=5')
      .set(operator('GET', '/internal/v1/audit/failures?page=1&pageSize=5'));
    expect(failures.status).toBe(200);
    validator.assertResponse('get', '/internal/v1/audit/failures', 200, failures.body);

    const records = await request(server())
      .get('/internal/v1/audit/records?page=1&pageSize=5')
      .set(operator('GET', '/internal/v1/audit/records?page=1&pageSize=5'));
    expect(records.status).toBe(200);
    validator.assertResponse('get', '/internal/v1/audit/records', 200, records.body);

    const wrongScope = await request(server())
      .get('/internal/v1/audit/records?page=1&pageSize=5')
      .set(inbound('GET', '/internal/v1/audit/records?page=1&pageSize=5'));
    expect(wrongScope.status).toBe(403);
    expect(wrongScope.body).toMatchObject({ code: 'HMAC_SCOPE_FORBIDDEN' });
    validator.assertResponse('get', '/internal/v1/audit/records', 403, wrongScope.body);

    const resolveMissing = randomUUID();
    const resolveBody = JSON.stringify({
      action: 'RELEASE_LOCK',
      note: 'contract',
      operator: 'contract-test',
    });
    const notFound = await request(server())
      .post(`/internal/v1/audit/operations/${resolveMissing}/resolve-review`)
      .set('Content-Type', 'application/json')
      .set(operator('POST', `/internal/v1/audit/operations/${resolveMissing}/resolve-review`, resolveBody))
      .send(resolveBody);
    expect(notFound.status).toBe(404);
    validator.assertResponse(
      'post',
      '/internal/v1/audit/operations/{operationId}/resolve-review',
      404,
      notFound.body,
    );
  });

  it('every documented path has at least one assertion in this suite (coverage guard)', () => {
    const covered = new Set([
      '/health',
      '/ready',
      '/internal/v1/wallets',
      '/internal/v1/wallets/{userId}',
      '/internal/v1/nfts/{tokenId}',
      '/internal/v1/metadata',
      '/internal/v1/metadata/{tokenId}',
      '/internal/v1/mints',
      '/internal/v1/operations/{operationId}',
      '/internal/v1/operations/{operationId}/cancel',
      '/internal/v1/external-consent-challenges',
      '/internal/v1/audit/failures',
      '/internal/v1/audit/records',
      '/internal/v1/audit/operations/{operationId}/resolve-review',
    ]);
    // Chain-dependent accept endpoints are contract-tested in the integration suite
    // (`remediation.integration-spec.ts`) where a real token exists.
    const chainOnly = new Set([
      '/internal/v1/transfers',
      '/internal/v1/withdrawals',
      '/internal/v1/reentries',
      '/internal/v1/external-resales',
      '/internal/v1/audit/failures/{failureId}/resolve',
    ]);
    for (const documented of validator.documentedPaths()) {
      expect(covered.has(documented) || chainOnly.has(documented)).toBe(true);
    }
  });
});
