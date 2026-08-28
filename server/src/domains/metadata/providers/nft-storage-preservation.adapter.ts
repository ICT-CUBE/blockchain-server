import { Injectable } from '@nestjs/common';

import type { PreservationPort, PreserveRequest } from '../application/preservation.port';

/**
 * NFT.Storage **Classic** (NFTUp, the Classic web app, Classic SDK, and the Pinning Service API at
 * `api.nft.storage/pins`) was **decommissioned on 2024-06-30** — it no longer accepts new
 * uploads/pins. This adapter therefore cannot preserve anything; it fails fast with an actionable
 * message rather than timing out against a dead endpoint (검증 피드백 2026-08-28).
 *
 * Preservation is *best-effort* (`MetadataService.tryPreserve` swallows the error and Mint READY
 * never depends on it), so a real deployment still functions — but NFR-011's "이중 보존" is reduced
 * to Pinata-only until `PreservationPort` is rebound to a live provider (Lighthouse / Storacha /
 * Filebase / a second Pinata account). The port interface is unchanged; only this class needs
 * replacing. `MetadataModule` logs a startup warning whenever `METADATA_PROVIDER=real` selects this.
 */
export class NftStorageDecommissionedError extends Error {
  constructor(tokenId: number) {
    super(
      `Cannot preserve tokenId ${tokenId}: NFT.Storage Classic (api.nft.storage/pins) was ` +
        'decommissioned 2024-06-30 and accepts no new pins. Long-term preservation is currently ' +
        'unavailable — rebind PreservationPort to a live provider (Lighthouse / Storacha / ' +
        'Filebase).',
    );
    this.name = 'NftStorageDecommissionedError';
  }
}

@Injectable()
export class NftStoragePreservationAdapter implements PreservationPort {
  preserve(request: PreserveRequest): Promise<{ evidenceId: string }> {
    return Promise.reject(new NftStorageDecommissionedError(request.tokenId));
  }
}
