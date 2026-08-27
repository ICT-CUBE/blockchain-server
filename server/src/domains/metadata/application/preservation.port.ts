export const PRESERVATION_PORT = Symbol('PRESERVATION_PORT');

export interface PreserveRequest {
  cid: string;
  chainId: number;
  contractAddress: string;
  tokenId: number;
}

/** Long-term preservation *by reference* — asks a separate archival provider to fetch and durably
 * store content already hot-pinned (and therefore publicly fetchable over IPFS) under `cid`, per
 * the standard IPFS "Pinning Service API" shape real providers implement (TASK-13 §4/§5 —
 * NFT.Storage's role, deliberately independent of Pinata's hot-pinning availability: §12's risk
 * "NFT.Storage가 hot pinning과 다른 SLA"). Never receives raw bytes — that is Pinata's job. */
export interface PreservationPort {
  preserve(request: PreserveRequest): Promise<{ evidenceId: string }>;
}
