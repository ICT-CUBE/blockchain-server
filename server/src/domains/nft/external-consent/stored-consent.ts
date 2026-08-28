import { createHash } from 'node:crypto';

import {
  decryptRawTransaction,
  encryptRawTransaction,
} from '../../transaction/encryption/raw-transaction-cipher';

/**
 * How an externally-signed `OwnerConsent` is carried from accept-time to the worker that submits
 * it (Reentry, External Resale) — 검증 D8: the signature is stored **encrypted** (same AES-256-GCM
 * envelope as raw transactions, same key), a SHA-256 of it is kept for audit/idempotency, and the
 * ciphertext is purged from `Operation.metadata` once the signed attempt is durably committed
 * (the calldata inside the encrypted raw transaction is then the only remaining copy).
 */
export interface StoredExternalConsent {
  consentNonce: string;
  consentDeadline: string;
  /** Present until the SIGNED attempt exists; `null` afterwards. */
  externalSignatureCiphertext: string | null;
  externalSignatureHash: string;
}

export function isStoredExternalConsent(
  value: unknown,
): value is StoredExternalConsent & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Partial<StoredExternalConsent>;
  return (
    typeof v.consentNonce === 'string' &&
    typeof v.consentDeadline === 'string' &&
    typeof v.externalSignatureHash === 'string' &&
    (typeof v.externalSignatureCiphertext === 'string' || v.externalSignatureCiphertext === null)
  );
}

export function hashExternalSignature(signatureHex: string): string {
  return createHash('sha256').update(signatureHex.toLowerCase()).digest('hex');
}

export function sealExternalSignature(key: Buffer, signatureHex: string): string {
  return encryptRawTransaction(key, signatureHex);
}

export function unsealExternalSignature(key: Buffer, ciphertext: string): string {
  return decryptRawTransaction(key, ciphertext);
}
