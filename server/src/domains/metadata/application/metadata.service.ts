import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, IsNull, Not, QueryFailedError } from 'typeorm';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { canonicalJsonStringify } from '../../../shared/idempotency/valid-command-hash';
import {
  MetadataDependency,
  MetadataDependencyKind,
  MetadataPinStatus,
  MetadataPreservationStatus,
} from '../persistence/metadata-dependency.entity';
import { decodeAndValidateImage } from '../image-validation';
import { PINNING_PORT, type PinningPort } from './pinning.port';
import { PRESERVATION_PORT, type PreservationPinState, type PreservationPort } from './preservation.port';
import type { PrepareMetadataRequest } from '../metadata-request.schema';

export interface PrepareMetadataResult {
  tokenId: number;
  metadataCid: string;
  tokenUri: string;
  ready: boolean;
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    typeof error.driverError === 'object' &&
    error.driverError !== null &&
    'code' in error.driverError &&
    (error.driverError as { code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

/**
 * TASK-13 §4/§5: builds the immutable core metadata JSON from an allowlisted input (already
 * enforced by `prepareMetadataRequestSchema.strict()`), hot-pins it and its image dependency via
 * `PinningPort`, best-effort long-term-preserves both via `PreservationPort`, and tracks every
 * dependency's status so `isReady`/`tokenUri` can tell "fully pinned, safe to mint" apart from
 * "still in progress" — TASK-07's `MintApplication` uses exactly that gate.
 *
 * Content-addressing (same input -> same CID) makes re-`prepare()`-ing the same logical input
 * idempotent for free: pinning the same bytes again yields the same CID, and the
 * `(tokenId, cid)` unique constraint absorbs the resulting duplicate-insert as "already recorded",
 * not an error.
 */
@Injectable()
export class MetadataService {
  private readonly logger = new Logger(MetadataService.name);

  constructor(
    @Inject(PINNING_PORT) private readonly pinning: PinningPort,
    @Inject(PRESERVATION_PORT) private readonly preservation: PreservationPort,
    private readonly dataSource: DataSource,
    private readonly appConfig: AppConfigService,
  ) {}

  async prepare(input: PrepareMetadataRequest): Promise<PrepareMetadataResult> {
    // 검증 개선안 §5: bounded, content-sniffed image bytes — never blindly decode and pin.
    const { bytes: imageBytes } = decodeAndValidateImage(
      input.imageBase64,
      input.imageMimeType,
      this.appConfig.metadata.imageMaxBytes,
    );
    const { cid: imageCid } = await this.pinning.pin(imageBytes);
    await this.recordDependency(input.tokenId, imageCid, MetadataDependencyKind.IMAGE, imageBytes);

    const coreJson = {
      tokenId: input.tokenId,
      cubeNumber: input.cubeNumber,
      publicGrade: input.publicGrade,
      image: `ipfs://${imageCid}`,
      benefitReference: input.benefitReferenceId,
    };
    const canonicalBytes = Buffer.from(canonicalJsonStringify(coreJson), 'utf8');
    const { cid: metadataCid } = await this.pinning.pin(canonicalBytes);
    await this.recordDependency(
      input.tokenId,
      metadataCid,
      MetadataDependencyKind.METADATA_JSON,
      canonicalBytes,
    );

    // Best-effort, isolated from the pin path entirely (TASK-13 §12: the archival provider's SLA is
    // deliberately independent of Pinata's — a preservation failure never blocks READY). Each CID
    // gets its own pin request (검증 문제 1); `ensurePreservation` is idempotent so a repeated or
    // concurrent prepare() never double-submits an already-PRESERVED or in-flight CID (검증 피드백).
    await Promise.all([
      this.ensurePreservation(input.tokenId, imageCid),
      this.ensurePreservation(input.tokenId, metadataCid),
    ]);
    await this.reconcilePreservation(input.tokenId);

    const ready = await this.isReady(input.tokenId);
    return { tokenId: input.tokenId, metadataCid, tokenUri: `ipfs://${metadataCid}`, ready };
  }

  /** READY (and, per TASK-13 §5, Mint-acceptable) only once every dependency row for `tokenId` is
   * PINNED — preservation status never gates this, only hot-pin availability does. */
  async isReady(tokenId: number): Promise<boolean> {
    const deps = await this.dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
    if (deps.length === 0) {
      return false;
    }
    return deps.every((dep) => dep.pinStatus === MetadataPinStatus.PINNED);
  }

  /** The tokenURI to mint with, or `null` if metadata isn't READY yet. */
  async tokenUri(tokenId: number): Promise<string | null> {
    const metadataDep = await this.dataSource
      .getRepository(MetadataDependency)
      .findOne({ where: { tokenId, kind: MetadataDependencyKind.METADATA_JSON } });
    if (!metadataDep || metadataDep.pinStatus !== MetadataPinStatus.PINNED) {
      return null;
    }
    return `ipfs://${metadataDep.cid}`;
  }

  async listDependencies(tokenId: number): Promise<MetadataDependency[]> {
    return this.dataSource.getRepository(MetadataDependency).find({ where: { tokenId } });
  }

  /**
   * Read-only best-effort refresh of `preservation_status` for every still-`PENDING` dependency of
   * `tokenId` that has a `preservation_request_id`: asks the provider whether the pin is
   * `pinned`/`failed` yet (a *read* — `checkStatus` — never a new `preserve()` submission),
   * leaving it `PENDING` while still `queued`/`pinning` or the provider is unreachable (검증 문제 2).
   * Called at the end of `prepare()` and on `GET /internal/v1/metadata/:id`. Stale `SUBMITTING`
   * recovery is NOT done here — that is `reconcilePreservationBatch()`'s (the worker's) job so it
   * does not depend on the Backend calling `prepare()` again (검증 피드백).
   */
  async reconcilePreservation(tokenId: number): Promise<void> {
    const pending = await this.dataSource.getRepository(MetadataDependency).find({
      where: { tokenId, preservationStatus: MetadataPreservationStatus.PENDING },
    });
    await Promise.all(
      pending
        .filter((dep) => dep.preservationRequestId !== null)
        .map((dep) => this.refreshOnePreservation(dep)),
    );
  }

  /**
   * The preservation reconciliation worker's pass (검증 피드백):
   *  1. `PENDING` + request id rows → `checkStatus` → `PRESERVED`/`FAILED` (same as above, but
   *     across all tokens, batched).
   *  2. stale `SUBMITTING` rows (submitter presumed crashed) → re-claim with a fresh token and
   *     resubmit via `ensurePreservation`, so recovery does not need a new `prepare()`.
   */
  async reconcilePreservationBatch(): Promise<void> {
    const repository = this.dataSource.getRepository(MetadataDependency);
    const limit = this.appConfig.metadata.preservationBatchSize;

    const pending = await repository.find({
      where: {
        preservationStatus: MetadataPreservationStatus.PENDING,
        preservationRequestId: Not(IsNull()),
      },
      take: limit,
    });
    await Promise.all(pending.map((dep) => this.refreshOnePreservation(dep)));

    const staleMicros = this.appConfig.metadata.preservationStaleClaimMs * 1000;
    const stale = await repository
      .createQueryBuilder('dep')
      .where('dep.preservation_status = :submitting', {
        submitting: MetadataPreservationStatus.SUBMITTING,
      })
      .andWhere(`dep.updated_at < DATE_SUB(NOW(3), INTERVAL ${staleMicros} MICROSECOND)`)
      .take(limit)
      .getMany();
    await Promise.all(stale.map((dep) => this.ensurePreservation(dep.tokenId, dep.cid)));
  }

  private async refreshOnePreservation(dep: MetadataDependency): Promise<void> {
    const requestId = dep.preservationRequestId;
    if (requestId === null) {
      return;
    }
    let state: PreservationPinState;
    try {
      state = await this.preservation.checkStatus(requestId);
    } catch (error) {
      this.logger.warn(
        `Preservation status check failed for tokenId ${dep.tokenId} cid ${dep.cid}: ${(error as Error).message}`,
      );
      return; // leave PENDING — a later pass retries
    }
    if (state !== 'pinned' && state !== 'failed') {
      return; // queued / pinning — still in progress
    }
    // Only write the outcome back if this is still the request we just checked — a concurrent
    // re-claim (new request id) must not be overwritten by a stale reconcile.
    await this.dataSource
      .createQueryBuilder()
      .update(MetadataDependency)
      .set({
        preservationStatus:
          state === 'pinned' ? MetadataPreservationStatus.PRESERVED : MetadataPreservationStatus.FAILED,
      })
      .where('token_id = :tokenId', { tokenId: dep.tokenId })
      .andWhere('cid = :cid', { cid: dep.cid })
      .andWhere('preservation_request_id = :requestId', { requestId })
      .execute();
  }

  private async recordDependency(
    tokenId: number,
    cid: string,
    kind: MetadataDependencyKind,
    bytes: Buffer,
  ): Promise<void> {
    const repository = this.dataSource.getRepository(MetadataDependency);
    const existing = await repository.findOne({ where: { tokenId, cid } });
    if (existing) {
      return; // Same content already recorded for this tokenId — idempotent re-prepare.
    }

    const checksum = createHash('sha256').update(bytes).digest('hex');
    const entity = repository.create({
      id: randomUUID(),
      tokenId,
      cid,
      kind,
      pinStatus: MetadataPinStatus.PINNED, // pin() above already succeeded before this is called
      preservationStatus: MetadataPreservationStatus.PENDING,
      checksum,
    });

    try {
      await repository.insert(entity);
    } catch (error) {
      if (!isDuplicateKeyError(error)) {
        throw error;
      }
      // Lost a race with a concurrent prepare() for the same (tokenId, cid) — fine, it's recorded.
    }
  }

  /**
   * Idempotently makes sure `cid` is submitted for preservation once per generation (검증 피드백 —
   * preservation 멱등성 & fencing):
   *
   *  - `PRESERVED`                       → nothing to do
   *  - `PENDING` with a request id       → already submitted, reconcile owns it
   *  - fresh `SUBMITTING`                → a concurrent `prepare()`/worker is submitting it right now
   *  - `PENDING` (no request id) / `FAILED` / stale `SUBMITTING` → atomically claim it (→ SUBMITTING,
   *    with a **fresh claim token** so the row genuinely changes — a stale re-claim would otherwise
   *    be a no-op) and submit under that token.
   *
   * The conditional `UPDATE` is the concurrency guard (only one caller's `affected` is 1). The
   * claim token is the *fencing* guard: `preserve()` writes its result back only while the token
   * still matches, so a submitter returning after its claim was reclaimed cannot clobber the
   * newer generation. External exactly-once is NOT guaranteed — Filebase may accept a duplicate
   * pin request for the same CID; the result (that CID is pinned) is what converges.
   */
  private async ensurePreservation(tokenId: number, cid: string): Promise<void> {
    const claimToken = randomUUID();
    const staleMicros = this.appConfig.metadata.preservationStaleClaimMs * 1000;
    const claim = await this.dataSource
      .createQueryBuilder()
      .update(MetadataDependency)
      .set({
        preservationStatus: MetadataPreservationStatus.SUBMITTING,
        preservationRequestId: null,
        preservationClaimToken: claimToken,
      })
      .where('token_id = :tokenId', { tokenId })
      .andWhere('cid = :cid', { cid })
      .andWhere(
        `(
          (preservation_status = 'PENDING' AND preservation_request_id IS NULL)
          OR preservation_status = 'FAILED'
          OR (preservation_status = 'SUBMITTING'
              AND updated_at < DATE_SUB(NOW(3), INTERVAL ${staleMicros} MICROSECOND))
        )`,
      )
      .execute();
    if (!claim.affected) {
      return; // PRESERVED, already-submitted PENDING, or a live concurrent submit — leave it be.
    }
    await this.submitPreservation(tokenId, cid, claimToken);
  }

  /** Runs one `preserve()` for a row this caller claimed under `claimToken`. On success the row
   * goes back to `PENDING` *with* the request id — a `queued` pin is accepted, not stored;
   * reconcile promotes it to `PRESERVED` once the provider confirms `pinned` (검증 문제 2·3). A
   * submission error is terminal `FAILED` until re-claimed. Either write only lands while the row
   * still carries `claimToken` (fencing) — and clears it, since the submission is done. */
  private async submitPreservation(tokenId: number, cid: string, claimToken: string): Promise<void> {
    try {
      const { requestId } = await this.preservation.preserve({
        cid,
        chainId: this.appConfig.cubeNft.deployment.chainId,
        contractAddress: this.appConfig.cubeNft.deployment.proxyAddress,
        tokenId,
      });
      await this.completeSubmission(tokenId, cid, claimToken, MetadataPreservationStatus.PENDING, requestId);
    } catch (error) {
      this.logger.warn(`Preservation failed for tokenId ${tokenId} cid ${cid}: ${(error as Error).message}`);
      await this.completeSubmission(tokenId, cid, claimToken, MetadataPreservationStatus.FAILED, null);
    }
  }

  private async completeSubmission(
    tokenId: number,
    cid: string,
    claimToken: string,
    status: MetadataPreservationStatus,
    requestId: string | null,
  ): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .update(MetadataDependency)
      .set({
        preservationStatus: status,
        preservationRequestId: requestId,
        preservationClaimToken: null,
      })
      .where('token_id = :tokenId', { tokenId })
      .andWhere('cid = :cid', { cid })
      .andWhere('preservation_claim_token = :claimToken', { claimToken })
      .execute();
  }
}
