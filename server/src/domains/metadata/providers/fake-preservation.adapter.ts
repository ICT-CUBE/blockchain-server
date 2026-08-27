import { Injectable } from '@nestjs/common';

import type { PreservationPort, PreserveRequest } from '../application/preservation.port';

/** Deterministic, in-process stand-in for NFT.Storage — always "succeeds" immediately, recording
 * an evidence id derived from the request so repeated calls for the same CID are idempotent. */
@Injectable()
export class FakePreservationAdapter implements PreservationPort {
  preserve(request: PreserveRequest): Promise<{ evidenceId: string }> {
    return Promise.resolve({ evidenceId: `fake-preservation:${request.cid}` });
  }
}
