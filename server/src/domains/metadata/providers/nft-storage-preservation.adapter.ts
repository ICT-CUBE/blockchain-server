import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import type { PreservationPort, PreserveRequest } from '../application/preservation.port';

const NFT_STORAGE_PINS_URL = 'https://api.nft.storage/pins';

/** Thrown when `NFT_STORAGE_TOKEN` is missing — see `PinataNotConfiguredError`'s identical
 * reasoning. */
export class NftStorageNotConfiguredError extends Error {
  constructor() {
    super('NFT.Storage adapter is selected but NFT_STORAGE_TOKEN is not set — see .env.example.');
    this.name = 'NftStorageNotConfiguredError';
  }
}

/**
 * Real adapter over NFT.Storage's `POST /pins` — the standard IPFS "Pinning Service API" shape
 * (`{cid, name}`, no raw bytes: the service fetches by CID from the wider IPFS network, which
 * Pinata's hot pin already makes reachable). Implemented per that published API contract but
 * **not** live-verified end-to-end — no `NFT_STORAGE_TOKEN` was available to this codebase at
 * implementation time (TASK-13 §14).
 */
@Injectable()
export class NftStoragePreservationAdapter implements PreservationPort {
  private readonly logger = new Logger(NftStoragePreservationAdapter.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async preserve(request: PreserveRequest): Promise<{ evidenceId: string }> {
    const { nftStorageToken, httpTimeoutMs } = this.appConfig.metadata;
    if (!nftStorageToken) {
      throw new NftStorageNotConfiguredError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const response = await fetch(NFT_STORAGE_PINS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${nftStorageToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ cid: request.cid, name: `cube-${request.tokenId}` }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`NFT.Storage /pins failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
      }
      const json = (await response.json()) as { requestid?: string; pin?: { cid?: string } };
      return { evidenceId: json.requestid ?? json.pin?.cid ?? request.cid };
    } finally {
      clearTimeout(timeout);
    }
  }
}
