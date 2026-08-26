import { randomBytes, randomUUID } from 'node:crypto';

import type { DataSource } from 'typeorm';

import {
  SignerNonceConflictError,
  SignerNonceReservationRepository,
} from '../../src/domains/transaction/persistence/signer-nonce-reservation.repository';
import { createTestDataSource } from './test-data-source';

const CHAIN_ID = 80002;

/** A fresh, valid-looking address per call, so repeated runs of this suite against the same
 * persistent test DB never collide with data a previous run left behind. */
function randomAddress(): string {
  return `0x${randomBytes(20).toString('hex')}`;
}

describe('SignerNonceReservationRepository (integration)', () => {
  let dataSource: DataSource;
  let repository: SignerNonceReservationRepository;

  beforeAll(async () => {
    dataSource = createTestDataSource();
    await dataSource.initialize();
    repository = new SignerNonceReservationRepository(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('allows only one of several concurrent reservations for the same (chainId, signer, nonce)', async () => {
    const signer = randomAddress();
    const nonce = String(Math.floor(Math.random() * 1_000_000));

    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => repository.reserve(CHAIN_ID, signer, nonce, randomUUID())),
    );

    const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
    const rejected = attempts.filter((a) => a.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect(r.reason).toBeInstanceOf(SignerNonceConflictError);
    }
  });

  it('tracks the highest reserved nonce per (chainId, signer)', async () => {
    const signer = randomAddress();
    expect(await repository.findHighestReservedNonce(CHAIN_ID, signer)).toBeNull();

    await repository.reserve(CHAIN_ID, signer, '10', randomUUID());
    await repository.reserve(CHAIN_ID, signer, '11', randomUUID());
    await repository.reserve(CHAIN_ID, signer, '12', randomUUID());

    expect(await repository.findHighestReservedNonce(CHAIN_ID, signer)).toBe('12');
  });

  it('different signers and different chains do not conflict on the same nonce value', async () => {
    const nonce = String(Math.floor(Math.random() * 1_000_000));
    const signerA = randomAddress();
    const signerB = randomAddress();
    await expect(repository.reserve(CHAIN_ID, signerA, nonce, randomUUID())).resolves.toBeDefined();
    await expect(repository.reserve(CHAIN_ID, signerB, nonce, randomUUID())).resolves.toBeDefined();
    await expect(repository.reserve(137, signerA, nonce, randomUUID())).resolves.toBeDefined();
  });
});
