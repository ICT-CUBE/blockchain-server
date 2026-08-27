import { randomBytes } from 'node:crypto';

import { decryptRawTransaction, encryptRawTransaction } from './raw-transaction-cipher';

describe('raw-transaction-cipher', () => {
  const key = randomBytes(32);
  const rawTransaction = '0x02f86f0182...deadbeef';

  it('round-trips a raw transaction through encrypt/decrypt', () => {
    const ciphertext = encryptRawTransaction(key, rawTransaction);
    expect(decryptRawTransaction(key, ciphertext)).toBe(rawTransaction);
  });

  it('produces different ciphertext for the same input on repeated calls (random IV)', () => {
    expect(encryptRawTransaction(key, rawTransaction)).not.toBe(encryptRawTransaction(key, rawTransaction));
  });

  it('fails to decrypt with the wrong key', () => {
    const ciphertext = encryptRawTransaction(key, rawTransaction);
    expect(() => decryptRawTransaction(randomBytes(32), ciphertext)).toThrow();
  });

  it('fails to decrypt tampered ciphertext', () => {
    const ciphertext = encryptRawTransaction(key, rawTransaction);
    const tampered = Buffer.from(ciphertext, 'base64');
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptRawTransaction(key, tampered.toString('base64'))).toThrow();
  });
});
