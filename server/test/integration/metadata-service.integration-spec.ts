import path from 'node:path';

import type { DataSource } from 'typeorm';

import { AppConfigService } from '../../src/shared/config/app-config.service';
import { MetadataService } from '../../src/domains/metadata/application/metadata.service';
import { FakePinningAdapter } from '../../src/domains/metadata/providers/fake-pinning.adapter';
import { FakePreservationAdapter } from '../../src/domains/metadata/providers/fake-preservation.adapter';
import type { PinningPort } from '../../src/domains/metadata/application/pinning.port';
import type {
  PreservationPinState,
  PreservationPort,
  PreserveRequest,
} from '../../src/domains/metadata/application/preservation.port';
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
  process.env.PORT = '3100';
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

/** Always fails preserve() — for exercising archival-provider-failure isolation. */
class FailingPreservationAdapter implements PreservationPort {
  preserve(): Promise<{ requestId: string }> {
    return Promise.reject(new Error('simulated preservation-provider outage'));
  }

  checkStatus(): Promise<PreservationPinState> {
    return Promise.reject(new Error('simulated preservation-provider outage'));
  }
}

/** Records every preserve() call and lets the test drive checkStatus() per requestId — so the
 * async lifecycle (queued → pinned/failed) can be asserted deterministically (검증 문제 1·2).
 * `gateForCid(cid)` holds *that CID's* preserve() open until `releaseGate()` — keyed by CID, not
 * call order, so `prepare()` submitting both CIDs concurrently cannot make the test flaky
 * (검증 피드백). A real process kill would take the in-flight call with it, so fencing is
 * exercised in-process instead. */
class RecordingPreservationAdapter implements PreservationPort {
  readonly preserved: PreserveRequest[] = [];
  failNextPreserve = false;
  private seq = 0;
  private gatedCid: string | null = null;
  private gate: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private readonly states = new Map<string, PreservationPinState>();

  constructor(private readonly initialState: PreservationPinState = 'queued') {}

  gateForCid(cid: string): void {
    this.gatedCid = cid;
  }

  async preserve(request: PreserveRequest): Promise<{ requestId: string }> {
    this.preserved.push(request);
    if (this.failNextPreserve) {
      this.failNextPreserve = false;
      throw new Error('simulated Filebase submit failure');
    }
    const requestId = `req-${request.cid}-${++this.seq}`;
    this.states.set(requestId, this.initialState);
    if (this.gatedCid === request.cid) {
      this.gatedCid = null;
      await new Promise<void>((resolve, reject) => {
        this.gate = { resolve, reject };
      });
    }
    return { requestId };
  }

  checkStatus(requestId: string): Promise<PreservationPinState> {
    return Promise.resolve(this.states.get(requestId) ?? 'failed');
  }

  countFor(cid: string): number {
    return this.preserved.filter((r) => r.cid === cid).length;
  }

  releaseGate(mode: 'resolve' | 'reject' = 'resolve'): void {
    const gate = this.gate;
    this.gate = null;
    if (mode === 'reject') {
      gate?.reject(new Error('simulated late Filebase failure'));
    } else {
      gate?.resolve();
    }
  }

  /** Drive the outcome for every request id issued for `cid` so far. */
  setStateForCid(cid: string, state: PreservationPinState): void {
    for (const key of this.states.keys()) {
      if (key.startsWith(`req-${cid}-`)) {
        this.states.set(key, state);
      }
    }
  }
}

/** The CID `FakePinningAdapter` will produce for `imageBytes` — precomputed so a test can gate that
 * exact CID's preserve() regardless of which of the two submissions the DB reaches first. */
async function fakeCidFor(imageBytes: Buffer): Promise<string> {
  const { cid } = await new FakePinningAdapter().pin(imageBytes);
  return cid;
}

/** Move a dependency's `updated_at` far into the past so it counts as a stale `SUBMITTING` claim. */
async function makeStale(dataSource: DataSource, tokenId: number, cid: string): Promise<void> {
  await dataSource.query(
    'UPDATE metadata_dependencies SET updated_at = DATE_SUB(NOW(3), INTERVAL 1 HOUR) WHERE token_id = ? AND cid = ?',
    [tokenId, cid],
  );
}

/** Poll until `cid`'s dependency for `tokenId` is in `SUBMITTING` (its `preserve()` was gated open). */
async function waitForSubmitting(dataSource: DataSource, tokenId: number, cid: string): Promise<void> {
  const repo = dataSource.getRepository(MetadataDependency);
  for (let i = 0; i < 200; i += 1) {
    const dep = await repo.findOne({ where: { tokenId, cid } });
    if (dep?.preservationStatus === MetadataPreservationStatus.SUBMITTING) {
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`dependency ${cid} for token ${tokenId} never reached SUBMITTING`);
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
    // fake provider reports `pinned` immediately, so the end-of-prepare reconcile promotes both.
    expect(deps.every((dep) => dep.preservationStatus === MetadataPreservationStatus.PRESERVED)).toBe(true);
    expect(deps.every((dep) => dep.preservationRequestId !== null)).toBe(true);
    expect(deps.some((dep) => dep.kind === MetadataDependencyKind.METADATA_JSON)).toBe(true);
    expect(deps.some((dep) => dep.kind === MetadataDependencyKind.IMAGE)).toBe(true);
  });

  it('submits the image and metadata CIDs as two distinct preservation requests (검증 문제 1)', async () => {
    const recording = new RecordingPreservationAdapter('queued');
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();

    const result = await service.prepare({
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });

    const cids = recording.preserved.map((r) => r.cid).sort();
    expect(cids).toHaveLength(2);
    expect(new Set(cids).size).toBe(2); // image CID and metadata CID are different requests
    expect(cids).toContain(result.metadataCid);

    // Every dependency has a stored requestId; none is PRESERVED yet (provider still `queued`).
    const deps = await dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
    expect(deps.every((dep) => dep.preservationRequestId !== null)).toBe(true);
    expect(deps.every((dep) => dep.preservationStatus === MetadataPreservationStatus.PENDING)).toBe(true);
  });

  it('keeps preservation PENDING while queued, promotes to PRESERVED only after checkStatus says pinned, FAILED on failed (검증 문제 2)', async () => {
    const recording = new RecordingPreservationAdapter('queued');
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();

    const result = await service.prepare({
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    });
    const repo = dataSource.getRepository(MetadataDependency);
    const imageCid = (await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } }))
      .cid;

    // Still queued → still PENDING after a reconcile.
    await service.reconcilePreservation(tokenId);
    expect(
      (await repo.find({ where: { tokenId } })).every(
        (d) => d.preservationStatus === MetadataPreservationStatus.PENDING,
      ),
    ).toBe(true);

    // Provider finishes: image pinned, metadata JSON failed.
    recording.setStateForCid(imageCid, 'pinned');
    recording.setStateForCid(result.metadataCid, 'failed');
    await service.reconcilePreservation(tokenId);

    const byKind = new Map(
      (await repo.find({ where: { tokenId } })).map((d) => [d.kind, d.preservationStatus]),
    );
    expect(byKind.get(MetadataDependencyKind.IMAGE)).toBe(MetadataPreservationStatus.PRESERVED);
    expect(byKind.get(MetadataDependencyKind.METADATA_JSON)).toBe(MetadataPreservationStatus.FAILED);
  });

  it('a repeated prepare() does not re-submit an already-PRESERVED or in-flight CID (검증 피드백 — 멱등성)', async () => {
    const recording = new RecordingPreservationAdapter('pinned'); // reconcile promotes to PRESERVED
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();
    const input = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    };

    const result = await service.prepare(input);
    const repo = dataSource.getRepository(MetadataDependency);
    const afterFirst = await repo.find({ where: { tokenId } });
    expect(afterFirst.every((d) => d.preservationStatus === MetadataPreservationStatus.PRESERVED)).toBe(true);
    const requestIds = new Map(afterFirst.map((d) => [d.cid, d.preservationRequestId]));

    // Re-prepare the exact same content twice more.
    await service.prepare(input);
    await service.prepare(input);

    expect(recording.countFor(result.metadataCid)).toBe(1); // submitted once, ever
    expect(recording.preserved).toHaveLength(2); // image + metadata, not 6
    const afterRepeats = await repo.find({ where: { tokenId } });
    for (const dep of afterRepeats) {
      expect(dep.preservationStatus).toBe(MetadataPreservationStatus.PRESERVED);
      expect(dep.preservationRequestId).toBe(requestIds.get(dep.cid)); // request id is immutable
    }
  });

  it('a repeated prepare() DOES retry a CID whose previous preservation submission FAILED', async () => {
    const recording = new RecordingPreservationAdapter('queued');
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();
    const input = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    };

    recording.failNextPreserve = true; // the image submission (first call) fails
    const result = await service.prepare(input);
    const repo = dataSource.getRepository(MetadataDependency);
    const image = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
    expect(image.preservationStatus).toBe(MetadataPreservationStatus.FAILED);
    expect(image.preservationRequestId).toBeNull();

    // Re-prepare: the FAILED image row is atomically reclaimed and resubmitted; the already-PENDING
    // metadata JSON row is not.
    await service.prepare(input);

    expect(recording.countFor(image.cid)).toBe(2); // failed once, retried once
    expect(recording.countFor(result.metadataCid)).toBe(1);
    const retried = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
    expect(retried.preservationStatus).toBe(MetadataPreservationStatus.PENDING);
    expect(retried.preservationRequestId).not.toBeNull();
  });

  it('two concurrent prepare() calls submit each CID exactly once', async () => {
    const recording = new RecordingPreservationAdapter('queued');
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();
    const input = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]).toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    };

    const [a] = await Promise.all([service.prepare(input), service.prepare(input)]);

    expect(recording.countFor(a.metadataCid)).toBe(1);
    const image = (
      await dataSource
        .getRepository(MetadataDependency)
        .find({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } })
    )[0];
    expect(recording.countFor(image!.cid)).toBe(1);
    expect(recording.preserved).toHaveLength(2);
  });

  it('the reconciliation worker re-claims and resubmits a stale SUBMITTING row without a new prepare() (검증 피드백)', async () => {
    const recording = new RecordingPreservationAdapter('queued');
    const service = makeService(new FakePinningAdapter(), recording);
    const tokenId = randomTokenId();
    const imageBytes = Buffer.concat([PNG_MAGIC, Buffer.from(`image-${tokenId}`)]);
    const input = {
      tokenId,
      cubeNumber: `CUBE-${tokenId}`,
      publicGrade: 'A',
      imageBase64: imageBytes.toString('base64'),
      benefitReferenceId: `benefit-${tokenId}`,
    };

    // Simulate a crash mid-submit: the image's preserve() hangs and never returns.
    const imageCid = await fakeCidFor(imageBytes);
    recording.gateForCid(imageCid);
    const preparing = service.prepare(input);
    // metadata JSON submits fine; image stays SUBMITTING regardless of submission ordering.
    await waitForSubmitting(dataSource, tokenId, imageCid);
    const repo = dataSource.getRepository(MetadataDependency);
    const image = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
    expect(image.preservationStatus).toBe(MetadataPreservationStatus.SUBMITTING);

    await makeStale(dataSource, tokenId, image.cid);

    // No new prepare() — only the worker's pass. It re-claims and resubmits.
    await service.reconcilePreservationBatch();
    const afterWorker = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
    expect(afterWorker.preservationStatus).toBe(MetadataPreservationStatus.PENDING);
    expect(afterWorker.preservationRequestId).not.toBeNull();
    expect(recording.countFor(image.cid)).toBe(2); // hung original + worker resubmit

    // Provider now confirms it; a second worker pass promotes it.
    recording.setStateForCid(image.cid, 'pinned');
    await service.reconcilePreservationBatch();
    const done = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
    expect(done.preservationStatus).toBe(MetadataPreservationStatus.PRESERVED);

    recording.releaseGate('reject'); // let the hung original settle (fenced)
    await preparing.catch(() => undefined);
  });

  it('a late preserve() completion (success or failure) cannot overwrite a newer claim (fencing, 검증 피드백)', async () => {
    for (const lateMode of ['resolve', 'reject'] as const) {
      const recording = new RecordingPreservationAdapter('queued');
      const service = makeService(new FakePinningAdapter(), recording);
      const tokenId = randomTokenId();
      const imageBytes = Buffer.concat([PNG_MAGIC, Buffer.from(`img-${tokenId}-${lateMode}`)]);
      const input = {
        tokenId,
        cubeNumber: `CUBE-${tokenId}`,
        publicGrade: 'A',
        imageBase64: imageBytes.toString('base64'),
        benefitReferenceId: `benefit-${tokenId}`,
      };

      const imageCid = await fakeCidFor(imageBytes);
      recording.gateForCid(imageCid); // hold submitter A (the image) open
      const preparing = service.prepare(input);
      await waitForSubmitting(dataSource, tokenId, imageCid);
      const repo = dataSource.getRepository(MetadataDependency);
      const image = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });

      await makeStale(dataSource, tokenId, image.cid);
      await service.reconcilePreservationBatch(); // submitter B re-claims and completes
      const afterB = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
      const bRequestId = afterB.preservationRequestId;
      expect(afterB.preservationStatus).toBe(MetadataPreservationStatus.PENDING);
      expect(bRequestId).not.toBeNull();

      // Now A finally returns — its write must be a no-op (prepare() awaits A's submit path,
      // so once `preparing` settles A's completeSubmission has already run).
      recording.releaseGate(lateMode);
      await preparing.catch(() => undefined);

      const final = await repo.findOneOrFail({ where: { tokenId, kind: MetadataDependencyKind.IMAGE } });
      expect(final.preservationRequestId).toBe(bRequestId); // A did not clobber B
      expect(final.preservationStatus).toBe(MetadataPreservationStatus.PENDING);
    }
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

  it('isolates an archival-provider failure from pin status — READY is unaffected when preservation is down', async () => {
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
    // ...even though every preservation submission failed outright.
    expect(deps.every((dep) => dep.preservationStatus === MetadataPreservationStatus.FAILED)).toBe(true);
    expect(deps.every((dep) => dep.preservationRequestId === null)).toBe(true);
  });
});
