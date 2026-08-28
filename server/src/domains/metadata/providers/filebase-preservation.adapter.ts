import { Injectable } from '@nestjs/common';

import { AppConfigService } from '../../../shared/config/app-config.service';
import type {
  PreservationPinState,
  PreservationPort,
  PreserveRequest,
} from '../application/preservation.port';

/** Thrown by `preserve`/`checkStatus` when `FILEBASE_PIN_TOKEN` is missing — see
 * `PinataNotConfiguredError`'s identical reasoning. */
export class FilebaseNotConfiguredError extends Error {
  constructor() {
    super('Filebase adapter is selected but FILEBASE_PIN_TOKEN is not set — see .env.example.');
    this.name = 'FilebaseNotConfiguredError';
  }
}

const PIN_STATES: readonly PreservationPinState[] = ['queued', 'pinning', 'pinned', 'failed'];

/**
 * Real adapter over **Filebase's IPFS Pinning Service API** (`{FILEBASE_PIN_ENDPOINT}/pins`,
 * per-bucket Bearer token — the vendor-agnostic IPFS "Pinning Service API" spec). Replaces the
 * NFT.Storage adapter, whose Classic pinning API was decommissioned 2024-06-30.
 *
 * Preservation is **by reference** (the CID is already hot-pinned on Pinata) and **asynchronous**:
 *
 *  - `preserve()` POSTs `{ cid }` (no `name` — it is optional, and reusing one across a token's
 *    image + metadata CIDs would collide: Filebase's 409 is a *name* conflict, 검증 문제 1) and
 *    returns Filebase's `requestid`. HTTP 202 + `status: "queued"` means *accepted*, not *stored*.
 *  - `checkStatus(requestId)` GETs `/pins/{requestId}` and returns the real pin state; only
 *    `pinned` means the second durable copy exists (검증 문제 2).
 *
 * Best-effort: `MetadataService` isolates every failure here from the Mint READY gate.
 */
@Injectable()
export class FilebasePreservationAdapter implements PreservationPort {
  constructor(private readonly appConfig: AppConfigService) {}

  async preserve(request: PreserveRequest): Promise<{ requestId: string }> {
    const json = await this.call('POST', '/pins', { cid: request.cid });
    const requestId = (json as { requestid?: unknown }).requestid;
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('Filebase POST /pins response did not include a requestid');
    }
    return { requestId };
  }

  async checkStatus(requestId: string): Promise<PreservationPinState> {
    const json = await this.call('GET', `/pins/${encodeURIComponent(requestId)}`);
    const status = (json as { status?: unknown }).status;
    if (typeof status !== 'string' || !PIN_STATES.includes(status as PreservationPinState)) {
      throw new Error(`Filebase GET /pins/${requestId} returned an unexpected status: ${String(status)}`);
    }
    return status as PreservationPinState;
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const { filebasePinToken, filebasePinEndpoint, httpTimeoutMs } = this.appConfig.metadata;
    if (!filebasePinToken) {
      throw new FilebaseNotConfiguredError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
    try {
      const response = await fetch(`${filebasePinEndpoint.replace(/\/$/, '')}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${filebasePinToken}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new Error(
          `Filebase ${method} ${path} failed: HTTP ${response.status} ${bodyText.slice(0, 200)}`,
        );
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
}
