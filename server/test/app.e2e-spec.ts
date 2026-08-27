import type { Server } from 'node:http';

import { type INestApplication } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { applyE2eTestEnv } from './helpers/e2e-env';

describe('AppModule (e2e)', () => {
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    applyE2eTestEnv();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ rawBody: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    process.env = originalEnv;
  });

  it('GET /health reports liveness without touching the deployment artifact', async () => {
    const response = await request(app.getHttpServer() as Server).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('GET /ready reports the resolved network and CubeNFT proxy address', async () => {
    const response = await request(app.getHttpServer() as Server).get('/ready');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ready',
      network: 'localhost',
      cubeNftProxyAddress: '0x1111111111111111111111111111111111111111',
    });
  });
});
