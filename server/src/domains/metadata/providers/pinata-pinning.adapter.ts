import { Injectable, Logger } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import type { PinningPort } from '../application/pinning.port';

const PINATA_PIN_FILE_URL = 'https://api.pinata.cloud/pinning/pinFileToIPFS';

/** Thrown by every method when `AppConfigService.metadata` is missing what this adapter needs to
 * actually call Pinata — see TASK-13 §13/§14: real integration is not claimed complete until a
 * credential exists and a live pin has been verified, however correct the code path is. */
export class PinataNotConfiguredError extends Error {
  constructor() {
    super('Pinata adapter is selected but PINATA_JWT is not set — see .env.example.');
    this.name = 'PinataNotConfiguredError';
  }
}

/**
 * Real adapter over Pinata's REST API (`POST /pinning/pinFileToIPFS`, JWT bearer auth — Pinata's
 * currently-documented auth method, replacing the older key/secret pair). Implemented per Pinata's
 * published API contract but **not** live-verified end-to-end: no `PINATA_JWT` was available to
 * this codebase at implementation time (TASK-13 §14). Uses the platform `fetch`/`FormData`/`Blob`
 * globals rather than Pinata's SDK, per §8's "가능하면 표준 HTTP client를 사용해 SDK 결합을 줄인다".
 */
@Injectable()
export class PinataPinningAdapter implements PinningPort {
  private readonly logger = new Logger(PinataPinningAdapter.name);

  constructor(private readonly appConfig: AppConfigService) {}

  async pin(bytes: Buffer): Promise<{ cid: string }> {
    const { pinataJwt, httpTimeoutMs } = this.appConfig.metadata;
    if (!pinataJwt) {
      throw new PinataNotConfiguredError();
    }

    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), 'content.bin');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const response = await fetch(PINATA_PIN_FILE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${pinataJwt}` },
        body: form,
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(`Pinata pinFileToIPFS failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`);
      }
      const json = (await response.json()) as { IpfsHash?: string };
      if (!json.IpfsHash) {
        throw new Error('Pinata pinFileToIPFS response did not include IpfsHash');
      }
      return { cid: json.IpfsHash };
    } finally {
      clearTimeout(timeout);
    }
  }
}
