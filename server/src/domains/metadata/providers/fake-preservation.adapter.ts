import { Injectable } from '@nestjs/common';

import type {
  PreservationPinState,
  PreservationPort,
  PreserveRequest,
} from '../application/preservation.port';

/** Deterministic, in-process stand-in for Filebase — accepts every request and reports it `pinned`
 * immediately, so the whole preservation lifecycle (requestId persistence, PENDING → reconcile →
 * PRESERVED) still runs end-to-end with no external service. The evidence id is derived from the
 * CID so repeated calls for the same content are idempotent. */
@Injectable()
export class FakePreservationAdapter implements PreservationPort {
  preserve(request: PreserveRequest): Promise<{ requestId: string }> {
    return Promise.resolve({ requestId: `fake-preservation:${request.cid}` });
  }

  checkStatus(): Promise<PreservationPinState> {
    return Promise.resolve('pinned');
  }
}
