import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';

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
import { PRESERVATION_PORT, type PreservationPort } from './preservation.port';
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

    // Best-effort, isolated from the pin path entirely (TASK-13 §12: NFT.Storage's SLA is
    // deliberately independent of Pinata's — a preservation failure never blocks READY).
    await Promise.all([
      this.tryPreserve(input.tokenId, imageCid),
      this.tryPreserve(input.tokenId, metadataCid),
    ]);

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

  private async tryPreserve(tokenId: number, cid: string): Promise<void> {
    try {
      await this.preservation.preserve({
        cid,
        chainId: this.appConfig.cubeNft.deployment.chainId,
        contractAddress: this.appConfig.cubeNft.deployment.proxyAddress,
        tokenId,
      });
      await this.dataSource
        .createQueryBuilder()
        .update(MetadataDependency)
        .set({ preservationStatus: MetadataPreservationStatus.PRESERVED })
        .where('token_id = :tokenId', { tokenId })
        .andWhere('cid = :cid', { cid })
        .execute();
    } catch (error) {
      this.logger.warn(`Preservation failed for tokenId ${tokenId} cid ${cid}: ${(error as Error).message}`);
      await this.dataSource
        .createQueryBuilder()
        .update(MetadataDependency)
        .set({ preservationStatus: MetadataPreservationStatus.FAILED })
        .where('token_id = :tokenId', { tokenId })
        .andWhere('cid = :cid', { cid })
        .execute();
    }
  }
}
