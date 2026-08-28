import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import type { PreservationPort, PreserveRequest } from '../application/preservation.port';

/** Thrown by `preserve` when `FILEBASE_PIN_TOKEN` is missing — see `PinataNotConfiguredError`'s
 * identical reasoning. */
export class FilebaseNotConfiguredError extends Error {
  constructor() {
    super('Filebase adapter is selected but FILEBASE_PIN_TOKEN is not set — see .env.example.');
    this.name = 'FilebaseNotConfiguredError';
  }
}

/**
 * Real adapter over **Filebase's IPFS Pinning Service API** (`POST {FILEBASE_PIN_ENDPOINT}/pins`,
 * per-bucket Bearer token — the vendor-agnostic IPFS "Pinning Service API" spec). Replaces the
 * NFT.Storage adapter, whose Classic pinning API was decommissioned 2024-06-30 (개선안-2 §2).
 *
 * Preservation is **by reference**: the CID is already hot-pinned on Pinata (and therefore fetchable
 * over the public IPFS network), so this only asks Filebase to fetch and durably keep a second,
 * independent copy — the port never carries raw bytes (TASK-13 §4/§5, NFR-011's "이중 보존" with an
 * SLA deliberately independent of Pinata's). Best-effort: `MetadataService.tryPreserve` swallows any
 * failure and Mint READY never depends on it.
 */
@Injectable()
export class FilebasePreservationAdapter implements PreservationPort {
  private readonly logger = new Logger(FilebasePreservationAdapter.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async preserve(request: PreserveRequest): Promise<{ evidenceId: string }> {
    const { filebasePinToken, filebasePinEndpoint, httpTimeoutMs } = this.appConfig.metadata;
    if (!filebasePinToken) {
      throw new FilebaseNotConfiguredError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const response = await fetch(`${filebasePinEndpoint.replace(/\/$/, '')}/pins`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${filebasePinToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cid: request.cid, name: `cube-${request.tokenId}` }),
        signal: controller.signal,
      });
      if (!response.ok) {
        // 409 == this CID is already pinned on this bucket: idempotent success, not a failure.
        if (response.status === 409) {
          return { evidenceId: `filebase:${request.cid}` };
        }
        const bodyText = await response.text().catch(() => '');
        throw new Error(`Filebase /pins failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
      }
      const json = (await response.json()) as { requestid?: string; pin?: { cid?: string } };
      return { evidenceId: json.requestid ?? json.pin?.cid ?? `filebase:${request.cid}` };
    } finally {
      clearTimeout(timeout);
    }
  }
}
