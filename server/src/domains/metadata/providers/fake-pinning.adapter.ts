import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import type { PinningPort } from '../application/pinning.port';

/** Deterministic, in-process stand-in for Pinata (TASK-13 §13, mirrors TASK-05's
 * FakeWeb3AuthAdapter): the "CID" is derived from a SHA-256 of the content itself, so the one
 * property every caller actually depends on — same bytes in, same CID out — holds exactly the way
 * it would against a real content-addressed pinning service. Prefixed distinctly from any real
 * CIDv0/v1 format so nothing downstream could mistake this for a real, dereferenceable CID. */
@Injectable()
export class FakePinningAdapter implements PinningPort {
  pin(bytes: Buffer): Promise<{ cid: string }> {
    const digest = createHash('sha256').update(bytes).digest('hex');
    return Promise.resolve({ cid: `fakecid1${digest}` });
  }
}
