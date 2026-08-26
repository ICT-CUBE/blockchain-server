import type { Server } from 'node:http';
import path from 'node:path';

import { Test, type TestingModule } from '@nestjs/testing';
import { type INestApplication } from '@nestjs/common';
import request from 'supertest';

import { AppModule } from '../src/app.module';

const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'deployments');

describe('AppModule (e2e)', () => {
  let app: INestApplication;
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    // Never actually bound: this suite calls app.init(), not app.listen().
    process.env.PORT = '3000';
    process.env.CUBE_NFT_NETWORK = 'localhost';
    process.env.CUBE_NFT_DEPLOYMENTS_DIR = FIXTURES_DIR;
    // AppModule does not import DatabaseModule (yet — that happens per-domain as each domain
    // module is wired in), so this only needs to satisfy env validation, not a real connection.
    process.env.DATABASE_URL = 'mysql://user:pass@127.0.0.1:3306/cube_nft_test';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
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
