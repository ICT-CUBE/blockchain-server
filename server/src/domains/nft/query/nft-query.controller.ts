import { Controller, Get, HttpCode, Param, ParseIntPipe, UseGuards } from '@nestjs/common';

import { HmacGuard } from '../../../shared/auth/hmac/hmac.guard';
import { AppConfigService } from '../../../shared/config/app-config.service';
import { ApiError } from '../../../shared/http/api-error';
import { CubeNftReaderService } from '../../transaction/rpc/cube-nft-reader.service';
import { describeRpcError } from '../../transaction/rpc/rpc-error';
import { RpcService } from '../../transaction/rpc/rpc.service';

/** `openapi.yaml#/components/schemas/NftView`. */
export interface NftViewResponse {
  tokenId: number;
  minted: boolean;
  ownerAddress: string | null;
  contractAddress: string;
  metadataUri: string | null;
  checkedAt: string;
  blockNumber: number;
}

/**
 * `GET /internal/v1/nfts/:tokenId` — FR-014~016 / AC-008~010: a read-only view of "is this token
 * minted, and to whom", straight from the chain, never from this server's own DB (Blockchain DB is
 * not an authoritative owner replica, 명세 §8.2). A never-minted token is a normal `minted: false`
 * answer; an RPC that cannot be reached is a retryable 503, so the two are never confused (AC-009).
 * HMAC only, no approval JWT (TASK-06 §4).
 */
@Controller('internal/v1/nfts')
@UseGuards(HmacGuard)
export class NftQueryController {
  constructor(
    private readonly reader: CubeNftReaderService,
    private readonly rpc: RpcService,
    private readonly appConfig: AppConfigService,
  ) {}

  @Get(':tokenId')
  @HttpCode(200)
  async view(@Param('tokenId', ParseIntPipe) tokenId: number): Promise<NftViewResponse> {
    if (tokenId < 1 || tokenId > 10000) {
      throw new ApiError('VALIDATION_FAILED', 'tokenId: must be between 1 and 10000', 400);
    }
    try {
      const [owner, blockNumber] = await Promise.all([
        this.reader.ownerOf(tokenId),
        this.rpc.getBlockNumber(),
      ]);
      const metadataUri = owner ? await this.reader.tokenUri(tokenId) : null;
      return {
        tokenId,
        minted: owner !== null,
        ownerAddress: owner,
        contractAddress: this.appConfig.cubeNft.deployment.proxyAddress,
        metadataUri,
        checkedAt: new Date().toISOString(),
        blockNumber,
      };
    } catch (error) {
      throw new ApiError(
        'NFT_LOOKUP_UNAVAILABLE',
        `Could not read tokenId ${tokenId} from the chain right now (${describeRpcError(error)}); retry later`,
        503,
      );
    }
  }
}
