import type { HmacKeyConfig } from '../../config/app-config';

export type HmacScope = 'inbound' | 'operator';

export interface ResolvedHmacKey {
  key: HmacKeyConfig;
  scope: HmacScope;
}

/** 검증 D10: both guards resolve a key id across *both* scopes so an authenticated-but-wrong-scope
 * request can be told apart from an unknown key. Signature verification still happens against the
 * matched key; only then does a scope mismatch become a 403 (authenticated, not authorized) rather
 * than a 401 (not authenticated). */
export function resolveHmacKeyAcrossScopes(
  keyId: string,
  inbound: { current: HmacKeyConfig; previous: HmacKeyConfig | null },
  operator: { current: HmacKeyConfig; previous: HmacKeyConfig | null },
): ResolvedHmacKey | null {
  for (const [scope, config] of [
    ['inbound', inbound],
    ['operator', operator],
  ] as const) {
    if (keyId === config.current.keyId) {
      return { key: config.current, scope };
    }
    if (config.previous && keyId === config.previous.keyId) {
      return { key: config.previous, scope };
    }
  }
  return null;
}
