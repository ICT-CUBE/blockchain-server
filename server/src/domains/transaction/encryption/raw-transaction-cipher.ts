import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;

/** AES-256-GCM at rest for `TransactionAttempt.rawTransactionCiphertext` (TASK-10 §5: dev key here,
 * production uses KMS envelope encryption instead — out of scope for this deployment target).
 * Output layout is `base64(iv || authTag || ciphertext)`, self-contained so decryption needs only
 * the key. */
export function encryptRawTransaction(key: Buffer, rawTransactionHex: string): string {
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(rawTransactionHex, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

export function decryptRawTransaction(key: Buffer, ciphertextBase64: string): string {
  const combined = Buffer.from(ciphertextBase64, 'base64');
  const iv = combined.subarray(0, IV_LENGTH_BYTES);
  const authTag = combined.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const ciphertext = combined.subarray(IV_LENGTH_BYTES + AUTH_TAG_LENGTH_BYTES);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
