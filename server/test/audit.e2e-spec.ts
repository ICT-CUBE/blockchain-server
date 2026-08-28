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
  HMAC_OPERATOR_KEY_ID,
  HMAC_OPERATOR_SECRET,
  HMAC_SECRET,
} from './helpers/e2e-env';
import { signHmacRequest } from './helpers/hmac-sign';
import { signApprovalJwt } from './helpers/jwt-sign';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // 검증 §5: metadata images must be real image bytes

const MINTS_PATH = '/internal/v1/mints';
const WALLETS_PATH = '/internal/v1/wallets';
const METADATA_PATH = '/internal/v1/metadata';
const AUDIT_RECORDS_PATH = '/internal/v1/audit/records';
const AUDIT_FAILURES_PATH = '/internal/v1/audit/failures';

function randomTokenId(): number {
  return Math.floor(Math.random() * 9000) + 1;
}

/**
 * TASK-14: exercises the operator-only audit/failure query surface end-to-end — a real Mint
 * accept writes a BUSINESS_EVENT `AuditRecord` (via `MintController`), readable only with the
 * separate `HMAC_OPERATOR_*` key scope (never the inbound key Backend uses to create Operations,
 * and vice versa — TASK-14 §5's "조회 API는 HMAC 운영 key scope를 분리").
 */
describe('TASK-14 audit/failure operator queries (e2e)', () => {
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

  function inboundHmacFor(
    bodyString: string,
    overrides: Partial<Parameters<typeof signHmacRequest>[0]> = {},
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

  function operatorHmacFor(
    overrides: Partial<Parameters<typeof signHmacRequest>[0]> & { path: string; method: string },
  ) {
    return signHmacRequest({
      bodyString: '',
      keyId: HMAC_OPERATOR_KEY_ID,
      secret: HMAC_OPERATOR_SECRET,
      ...overrides,
    });
  }

  async function walletAddressFor(userId: string): Promise<string> {
    const bodyString = JSON.stringify({ userId });
    const response = await request(server())
      .post(WALLETS_PATH)
      .set('Content-Type', 'application/json')
      .set(inboundHmacFor(bodyString, { path: WALLETS_PATH }))
      .send(bodyString);
    if (response.status !== 200) {
      throw new Error(`Failed to provision test wallet for ${userId}: ${response.status}`);
    }
    return (response.body as { address: string }).address;
  }

  async function prepareMetadataFor(tokenId: number): Promise<void> {
    const bodyString = JSON.stringify({
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`fixture-image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });
    const response = await request(server())
      .post(METADATA_PATH)
      .set('Content-Type', 'application/json')
      .set(inboundHmacFor(bodyString, { path: METADATA_PATH }))
      .send(bodyString);
    if (response.status !== 200) {
      throw new Error(`Failed to prepare test metadata for tokenId ${tokenId}: ${response.status}`);
    }
  }

  async function acceptMint(userId: string): Promise<{ operationId: string; tokenId: number }> {
    const tokenId = randomTokenId();
    await prepareMetadataFor(tokenId);
    const to = await walletAddressFor(userId);
    const body = { idempotencyKey: randomUUID(), userId, cubeId: `cube-${tokenId}`, tokenId };
    const bodyString = JSON.stringify(body);
    const token = signApprovalJwt({
      claims: {
        jti: randomUUID(),
        purpose: OperationType.MINT,
        tokenId,
        userId,
        cubeId: body.cubeId,
        to,
      },
      secret: APPROVAL_JWT_SECRET,
      issuer: APPROVAL_JWT_ISSUER,
      audience: APPROVAL_JWT_AUDIENCE,
    });

    const response = await request(server())
      .post(MINTS_PATH)
      .set('Content-Type', 'application/json')
      .set(inboundHmacFor(bodyString))
      .set('Authorization', `Bearer ${token}`)
      .send(bodyString);
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ status: OperationStatus.REQUESTED });
    return { operationId: (response.body as { operationId: string }).operationId, tokenId };
  }

  it('records a MINT_ACCEPTED audit event, readable via the operator key by operationId', async () => {
    const userId = `user-${randomUUID()}`;
    const { operationId, tokenId } = await acceptMint(userId);

    // The MINT_ACCEPTED audit write is deliberately fire-and-forget after the 202 (TASK-14 §9), so
    // poll briefly instead of assuming it already landed.
    let response = await request(server())
      .get(AUDIT_RECORDS_PATH)
      .query({ operationId })
      .set(operatorHmacFor({ method: 'GET', path: AUDIT_RECORDS_PATH, query: { operationId } }));
    for (let attempt = 0; attempt < 20 && (response.body as { total: number }).total === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await request(server())
        .get(AUDIT_RECORDS_PATH)
        .query({ operationId })
        .set(operatorHmacFor({ method: 'GET', path: AUDIT_RECORDS_PATH, query: { operationId } }));
    }

    expect(response.status).toBe(200);
    const body = response.body as { items: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      category: 'BUSINESS_EVENT',
      action: 'MINT_ACCEPTED',
      actor: userId,
      target: String(tokenId),
      operationId,
    });
  });

  it('rejects the audit query endpoint when signed with the inbound (non-operator) key', async () => {
    const response = await request(server())
      .get(AUDIT_RECORDS_PATH)
      .set(
        signHmacRequest({
          method: 'GET',
          path: AUDIT_RECORDS_PATH,
          bodyString: '',
          keyId: HMAC_KEY_ID,
          secret: HMAC_SECRET,
        }),
      );

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'HMAC_SCOPE_FORBIDDEN' });
  });

  it('rejects the mint endpoint when signed with the operator (non-inbound) key', async () => {
    const body = {
      idempotencyKey: randomUUID(),
      userId: 'user-x',
      cubeId: 'cube-x',
      tokenId: randomTokenId(),
    };
    const bodyString = JSON.stringify(body);

    const response = await request(server())
      .post(MINTS_PATH)
      .set('Content-Type', 'application/json')
      .set(
        signHmacRequest({
          method: 'POST',
          path: MINTS_PATH,
          bodyString,
          keyId: HMAC_OPERATOR_KEY_ID,
          secret: HMAC_OPERATOR_SECRET,
        }),
      )
      .send(bodyString);

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'HMAC_SCOPE_FORBIDDEN' });
  });

  it('returns an empty failures page and 404s resolving a non-existent failure record', async () => {
    const queryOperationId = randomUUID();
    const listResponse = await request(server())
      .get(AUDIT_FAILURES_PATH)
      .query({ operationId: queryOperationId })
      .set(
        operatorHmacFor({
          method: 'GET',
          path: AUDIT_FAILURES_PATH,
          query: { operationId: queryOperationId },
        }),
      );
    expect(listResponse.status).toBe(200);
    expect((listResponse.body as { total: number }).total).toBe(0);

    const missingId = randomUUID();
    const resolvePath = `${AUDIT_FAILURES_PATH}/${missingId}/resolve`;
    const resolveBody = JSON.stringify({ resolution: 'checked, no action needed' });
    const resolveResponse = await request(server())
      .post(resolvePath)
      .set('Content-Type', 'application/json')
      .set(operatorHmacFor({ method: 'POST', path: resolvePath, bodyString: resolveBody }))
      .send(resolveBody);

    expect(resolveResponse.status).toBe(404);
    expect(resolveResponse.body).toMatchObject({ code: 'FAILURE_RECORD_NOT_FOUND' });
  });
});
