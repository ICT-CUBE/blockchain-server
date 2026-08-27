import { createHash } from 'node:crypto';

/** Deterministic JSON serialization: object keys sorted recursively, arrays kept in order. Two
 * calls with the same logical value always produce byte-identical output regardless of property
 * insertion order — required for hashing to be a meaningful "same request or not" comparison. */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Hashes the normalized, business-meaningful fields of a request — operation type, tokenId,
 * addresses, purpose, and whatever else that operation's Application considers part of "the same
 * command" — so `OperationRepository.createOrGet` can tell an exact resend of `idempotencyKey`
 * apart from a conflicting reuse with different content (FR-030~032, TASK-06 §5).
 *
 * Callers pass only fields that make two requests "the same command" if equal; never include
 * request-scoped noise (timestamps, request ids) or secrets.
 */
export function computeValidCommandHash(fields: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJsonStringify(fields), 'utf8').digest('hex');
}
