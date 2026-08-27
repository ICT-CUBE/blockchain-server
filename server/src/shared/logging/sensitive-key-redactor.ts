/** Matches a key name that looks like it could hold a secret — case-insensitive, matches
 * anywhere in the key (so `walletPrivateKey`, `PRIVATE_KEY`, and `signatureHex` all match). This is
 * the "금지 key 검사기" safety net behind `AuditWriter`'s allowlist projection (TASK-14 §5/§12):
 * callers should only ever pass small, deliberately-chosen `details` objects, but this catches a
 * mistake before it reaches durable storage instead of trusting every call site to get it right. */
const FORBIDDEN_KEY_PATTERN =
  /secret|password|private[_-]?key|token|signature|jwt|mnemonic|seed|api[_-]?key|authorization|ciphertext/i;

const REDACTED = '[REDACTED]';

/** Deep-clones `value`, replacing the value of any object key matching `FORBIDDEN_KEY_PATTERN`
 * with `"[REDACTED]"`. Calls `onRedacted(path)` for every key it redacts, so callers can log a
 * warning surfacing the mistake instead of silently swallowing it. */
export function redactSensitiveKeys(value: unknown, onRedacted: (path: string) => void, path = ''): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSensitiveKeys(item, onRedacted, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      const entryPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        onRedacted(entryPath);
        result[key] = REDACTED;
      } else {
        result[key] = redactSensitiveKeys(entryValue, onRedacted, entryPath);
      }
    }
    return result;
  }
  return value;
}
