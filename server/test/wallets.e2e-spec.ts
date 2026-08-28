import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { applyE2eTestEnv, HMAC_KEY_ID, HMAC_SECRET } from './helpers/e2e-env';
import { signHmacRequest } from './helpers/hmac-sign';

describe('POST /internal/v1/wallets + GET /internal/v1/wallets/:userId (e2e)', () => {
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

  function hmacFor(method: string, path: string, bodyString = '') {
    return signHmacRequest({ method, path, bodyString, keyId: HMAC_KEY_ID, secret: HMAC_SECRET });
  }

  it('prepares a wallet, then finds the same wallet by userId', async () => {
    const userId = `user-${randomUUID()}`;
    const bodyString = JSON.stringify({ userId });

    const prepareResponse = await request(server())
      .post('/internal/v1/wallets')
      .set('Content-Type', 'application/json')
      .set(hmacFor('POST', '/internal/v1/wallets', bodyString))
      .send(bodyString);

    expect(prepareResponse.status).toBe(200);
    expect(prepareResponse.body).toMatchObject({
      userId,
      provider: 'WEB3AUTH',
      providerAdapter: 'fake-web3auth',
      integrationReady: false,
    });
    expect(typeof (prepareResponse.body as { address: string }).address).toBe('string');
    // Never return anything resembling a raw private key.
    expect(JSON.stringify(prepareResponse.body)).not.toMatch(/^0x[0-9a-fA-F]{64}$/);

    const findResponse = await request(server())
      .get(`/internal/v1/wallets/${userId}`)
      .set(hmacFor('GET', `/internal/v1/wallets/${userId}`));

    expect(findResponse.status).toBe(200);
    expect(findResponse.body).toEqual(prepareResponse.body);
  });

  it('preparing the same userId twice returns the same wallet address', async () => {
    const userId = `user-${randomUUID()}`;
    const bodyString = JSON.stringify({ userId });

    const first = await request(server())
      .post('/internal/v1/wallets')
      .set('Content-Type', 'application/json')
      .set(hmacFor('POST', '/internal/v1/wallets', bodyString))
      .send(bodyString);

    const second = await request(server())
      .post('/internal/v1/wallets')
      .set('Content-Type', 'application/json')
      .set(hmacFor('POST', '/internal/v1/wallets', bodyString))
      .send(bodyString);

    expect(second.status).toBe(200);
    expect((second.body as { address: string }).address).toBe((first.body as { address: string }).address);
  });

  it('GET for a userId that was never prepared returns 404', async () => {
    const userId = `user-${randomUUID()}`;
    const response = await request(server())
      .get(`/internal/v1/wallets/${userId}`)
      .set(hmacFor('GET', `/internal/v1/wallets/${userId}`));

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'WALLET_NOT_FOUND' });
  });

  it('rejects a wallet request without valid HMAC signing', async () => {
    const response = await request(server())
      .post('/internal/v1/wallets')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ userId: 'someone' }));

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'HMAC_MISSING_HEADERS' });
  });
});
