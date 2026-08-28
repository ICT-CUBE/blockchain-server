export const PRESERVATION_PORT = Symbol('PRESERVATION_PORT');

export interface PreserveRequest {
  cid: string;
  chainId: number;
  contractAddress: string;
  tokenId: number;
}

/** The four states a pin can be in, per the standard IPFS Pinning Service API. `preserve()` only
 * gets you as far as `queued` — the content is durably stored only once `checkStatus` reports
 * `pinned`. */
export type PreservationPinState = 'queued' | 'pinning' | 'pinned' | 'failed';

/**
 * Long-term preservation *by reference* — asks a separate archival provider (Filebase) to fetch and
 * durably store content already hot-pinned by Pinata (and therefore publicly fetchable over IPFS)
 * under `cid`, via the standard IPFS "Pinning Service API" (`POST /pins`). Deliberately independent
 * of Pinata's hot-pinning availability (NFR-011 "이중 보존"). Never receives raw bytes — that is
 * Pinata's job.
 *
 * The pin is asynchronous: `preserve()` returns a `requestId` for a `queued` request; the caller
 * must persist it and later poll `checkStatus(requestId)` before treating the content as PRESERVED
 * (검증 문제 2·3).
 */
export interface PreservationPort {
  preserve(request: PreserveRequest): Promise<{ requestId: string }>;
  checkStatus(requestId: string): Promise<PreservationPinState>;
}
