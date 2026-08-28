import path from 'node:path';

import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { MetadataService } from '../../src/domains/metadata/application/metadata.service';
import { FakePinningAdapter } from '../../src/domains/metadata/providers/fake-pinning.adapter';
import { FakePreservationAdapter } from '../../src/domains/metadata/providers/fake-preservation.adapter';
import type { PinningPort } from '../../src/domains/metadata/application/pinning.port';
import type { PreservationPort } from '../../src/domains/metadata/application/preservation.port';
import {
  MetadataDependency,
  MetadataDependencyKind,
  MetadataPinStatus,
  MetadataPreservationStatus,
} from '../../src/domains/metadata/persistence/metadata-dependency.entity';
import { prepareMetadataRequestSchema } from '../../src/domains/metadata/metadata-request.schema';
import { createTestDataSource } from './test-data-source';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // 검증 §5: metadata images must be real image bytes

const CONTRACTS_DEPLOYMENTS_DIR = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments');

function setEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '3000';
  process.env.CUBE_NFT_NETWORK = 'hardhatMainnet';
  process.env.CUBE_NFT_DEPLOYMENTS_DIR = CONTRACTS_DEPLOYMENTS_DIR;
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? 'mysql://cube_nft:cube_nft_test_pw@127.0.0.1:3307/cube_nft_test';
  process.env.HMAC_INBOUND_KEY_ID = 'backend-v1';
  process.env.HMAC_INBOUND_KEY_SECRET = Buffer.alloc(32, 1).toString('base64url');
  process.env.HMAC_OPERATOR_KEY_ID = 'operator-v1';
  process.env.HMAC_OPERATOR_KEY_SECRET = Buffer.alloc(32, 101).toString('base64url');
  process.env.APPROVAL_JWT_SECRET = Buffer.alloc(32, 2).toString('base64url');
  process.env.APPROVAL_JWT_ISSUER = 'arzone-backend';
  process.env.APPROVAL_JWT_AUDIENCE = 'arzone-blockchain-server';
  process.env.RAW_TX_ENCRYPTION_KEY = Buffer.alloc(32, 25).toString('base64');
  process.env.NOTIFICATION_CALLBACK_URL = 'http://127.0.0.1:4100/webhook';
  process.env.HMAC_OUTBOUND_KEY_ID = 'outbound-v1';
  process.env.HMAC_OUTBOUND_KEY_SECRET = Buffer.alloc(32, 26).toString('base64url');
}

/** Always fails preserve() — for exercising provider-failure isolation. */
class FailingPreservationAdapter implements PreservationPort {
  preserve(): Promise<{ evidenceId: string }> {
    return Promise.reject(new Error('simulated NFT.Storage outage'));
  }
}

/** Fails pin() for exactly the tokenIds in `failForTokenIds` — used to prove a single failed
 * dependency blocks READY for that token without affecting anything else. */
class SelectivelyFailingPinningAdapter implements PinningPort {
  constructor(
    private readonly delegate: PinningPort,
    private readonly failurePredicate: (bytes: Buffer) => boolean,
  ) {}

  async pin(bytes: Buffer): Promise<{ cid: string }> {
    if (this.failurePredicate(bytes)) {
      throw new Error('simulated Pinata failure');
    }
    return this.delegate.pin(bytes);
  }
}

function randomTokenId(): number {
  return Math.floor(Math.random() * 9000) + 1;
}

describe('MetadataService (integration, real DB)', () => {
  let dataSource: DataSource;
  let appConfig: AppConfigService;

  beforeAll(async () => {
    setEnv();
    dataSource = createTestDataSource();
    await dataSource.initialize();
    appConfig = new AppConfigService();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  function makeService(pinning: PinningPort, preservation: PreservationPort): MetadataService {
    return new MetadataService(pinning, preservation, dataSource, appConfig);
  }

  it('rejects a request carrying a field outside the allowlist', () => {
    const result = prepareMetadataRequestSchema.safeParse({
      tokenId: 1,
      cubeNumber: 'CUBE-1',
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from('x')]).toString('base64'),
      benefitReferenceId: 'benefit-1',
      ownerNationalId: '123-45-6789', // not on the allowlist — must be rejected outright
    });
    expect(result.success).toBe(false);
  });

  it('produces the same metadata CID for the same logical input (content-addressing)', async () => {
    const service = makeService(new FakePinningAdapter(), new FakePreservationAdapter());
    const tokenId = randomTokenId();
    const input = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    };

    const first = await service.prepare(input);
    const second = await service.prepare(input);

    expect(second.metadataCid).toBe(first.metadataCid);
    expect(second.tokenUri).toBe(first.tokenUri);

    // Idempotent re-prepare must not duplicate dependency rows.
    const deps = await dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
    expect(deps).toHaveLength(2); // one METADATA_JSON, one IMAGE
  });

  it('marks metadata READY only once every dependency is pinned, and records long-term preservation evidence', async () => {
    const service = makeService(new FakePinningAdapter(), new FakePreservationAdapter());
    const tokenId = randomTokenId();

    expect(await service.isReady(tokenId)).toBe(false);

    const result = await service.prepare({
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });

    expect(result.ready).toBe(true);
    expect(await service.isReady(tokenId)).toBe(true);
    expect(await service.tokenUri(tokenId)).toBe(result.tokenUri);

    const deps = await dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
    expect(deps.every((dep) => dep.pinStatus === MetadataPinStatus.PINNED)).toBe(true);
    expect(deps.every((dep) => dep.preservationStatus === MetadataPreservationStatus.PRESERVED)).toBe(true);
    expect(deps.some((dep) => dep.kind === MetadataDependencyKind.METADATA_JSON)).toBe(true);
    expect(deps.some((dep) => dep.kind === MetadataDependencyKind.IMAGE)).toBe(true);
  });

  it('does not reach READY if the image dependency fails to pin, even though the metadata JSON step never runs', async () => {
    const tokenId = randomTokenId();
    const imageBytes = Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64');
    const failingPinning = new SelectivelyFailingPinningAdapter(new FakePinningAdapter(), () => true);
    const service = makeService(failingPinning, new FakePreservationAdapter());

    await expect(
      service.prepare({
        tokenId,
        cubeNumber: `CUBE-${tokenId}`,
        publicGrade: 'A',
        imageBase64: imageBytes,
        benefitReferenceId: `benefit-${tokenId}`,
      }),
    ).rejects.toThrow('simulated Pinata failure');

    expect(await service.isReady(tokenId)).toBe(false);
    expect(await service.tokenUri(tokenId)).toBeNull();
  });

  it('isolates a preservation-provider failure from pin status — READY is unaffected by NFT.Storage being down', async () => {
    const service = makeService(new FakePinningAdapter(), new FailingPreservationAdapter());
    const tokenId = randomTokenId();

    const result = await service.prepare({
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });

    expect(result.ready).toBe(true); // pinning succeeded, so still READY...
    const deps = await dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
    expect(deps.every((dep) => dep.pinStatus === MetadataPinStatus.PINNED)).toBe(true);
    expect(deps.every((dep) => dep.preservationStatus === MetadataPreservationStatus.FAILED)).toBe(true); // ...even though preservation failed
  });
});
