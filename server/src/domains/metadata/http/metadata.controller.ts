import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { MetadataService } from '../application/metadata.service';
import { prepareMetadataRequestSchema, type PrepareMetadataRequest } from '../metadata-request.schema';
import { MetadataPreservationStatus } from '../persistence/metadata-dependency.entity';
import type { MetadataStatusResponse, PrepareMetadataResponse } from './metadata.response';

/** `POST /internal/v1/metadata` (prepare) and `GET /internal/v1/metadata/:tokenId` (status) —
 * both HMAC only, no approval JWT (TASK-06 §4: "Wallet·조회·Metadata 준비는 HMAC만 사용한다"): neither
 * moves NFT ownership, they only prepare/report the immutable metadata a later Mint will use. */
@Controller('internal/v1/metadata')
@UseGuards(HmacGuard)
export class MetadataController {
  constructor(private readonly metadataService: MetadataService) {}

  @Post()
  @HttpCode(200)
  async prepare(
    @Body(new ZodValidationPipe(prepareMetadataRequestSchema)) body: PrepareMetadataRequest,
  ): Promise<PrepareMetadataResponse> {
    return this.metadataService.prepare(body);
  }

  @Get(':tokenId')
  @HttpCode(200)
  async status(@Param('tokenId', ParseIntPipe) tokenId: number): Promise<MetadataStatusResponse> {
    // Refresh any PENDING preservation pins against the provider before reporting (검증 문제 2).
    await this.metadataService.reconcilePreservation(tokenId);
    const [ready, tokenUri, dependencies] = await Promise.all([
      this.metadataService.isReady(tokenId),
      this.metadataService.tokenUri(tokenId),
      this.metadataService.listDependencies(tokenId),
    ]);
    return {
      tokenId,
      ready,
      tokenUri,
      dependencies: dependencies.map((dep) => ({
        cid: dep.cid,
        kind: dep.kind,
        pinStatus: dep.pinStatus,
        // SUBMITTING is a transient internal claim marker — the API only exposes the three
        // observable states (검증 피드백).
        preservationStatus:
          dep.preservationStatus === MetadataPreservationStatus.SUBMITTING
            ? MetadataPreservationStatus.PENDING
            : dep.preservationStatus,
        preservationRequestId: dep.preservationRequestId,
      })),
    };
  }
}
