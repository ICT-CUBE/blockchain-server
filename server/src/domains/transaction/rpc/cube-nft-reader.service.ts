import { Injectable } from '@nestjs/common';
import { Interface } from 'ethers';

import { AppConfigService } from '../../../shared/config/app-config.service';
import { RpcService } from './rpc.service';

const OWNER_OF_INTERFACE = new Interface(['function ownerOf(uint256) view returns (address)']);

function isNonexistentTokenRevert(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'CALL_EXCEPTION'
  );
}

/** Small shared read helper over `CubeNFT.ownerOf` — used by every domain that needs to know
 * "is this tokenId minted, and to whom" before deciding what to do (TASK-07's idempotent-mint /
 * owner-conflict check, TASK-08/09's pre-transfer owner verification, TASK-11's confirmation). */
@Injectable()
export class CubeNftReaderService {
  constructor(
    private readonly rpc: RpcService,
    private readonly appConfig: AppConfigService,
  ) {}

  /** Returns the current owner, or `null` if `tokenId` has never been minted
   * (`ERC721NonexistentToken`). Rethrows anything else (RPC/network failure) — callers should
   * treat that as "unknown, retry later", not "not minted". */
  async ownerOf(tokenId: number): Promise<string | null> {
    const data = OWNER_OF_INTERFACE.encodeFunctionData('ownerOf', [tokenId]);
    try {
      const raw = await this.rpc
        .getReadProvider()
        .call({ to: this.appConfig.cubeNft.deployment.proxyAddress, data });
      const [owner] = OWNER_OF_INTERFACE.decodeFunctionResult('ownerOf', raw);
      return owner as string;
    } catch (error) {
      if (isNonexistentTokenRevert(error)) {
        return null;
      }
      throw error;
    }
  }
}
