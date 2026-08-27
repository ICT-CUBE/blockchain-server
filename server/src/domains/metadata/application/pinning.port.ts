export const PINNING_PORT = Symbol('PINNING_PORT');

/** Content-addressed pin: "hot" availability of `bytes`, immediately fetchable over IPFS
 * (TASK-13 §4/§5 — Pinata's role). Real implementations MUST be content-addressed (the same
 * bytes always yield the same `cid`) — that property, not anything this service does, is what
 * makes "같은 입력 같은 CID" true. */
export interface PinningPort {
  pin(bytes: Buffer): Promise<{ cid: string }>;
}
