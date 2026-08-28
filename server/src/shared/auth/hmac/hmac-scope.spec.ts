import { resolveHmacKeyAcrossScopes } from './hmac-scope';

const inbound = {
  current: { keyId: 'backend-v1', secret: Buffer.alloc(32, 1) },
  previous: { keyId: 'backend-v0', secret: Buffer.alloc(32, 2) },
};
const operator = {
  current: { keyId: 'operator-v1', secret: Buffer.alloc(32, 3) },
  previous: null,
};

describe('resolveHmacKeyAcrossScopes (검증 D10)', () => {
  it('resolves current and rotation keys of both scopes with their scope tag', () => {
    expect(resolveHmacKeyAcrossScopes('backend-v1', inbound, operator)).toEqual({
      key: inbound.current,
      scope: 'inbound',
    });
    expect(resolveHmacKeyAcrossScopes('backend-v0', inbound, operator)).toEqual({
      key: inbound.previous,
      scope: 'inbound',
    });
    expect(resolveHmacKeyAcrossScopes('operator-v1', inbound, operator)).toEqual({
      key: operator.current,
      scope: 'operator',
    });
  });

  it('returns null for an unknown key id (→ 401, not 403)', () => {
    expect(resolveHmacKeyAcrossScopes('nobody', inbound, operator)).toBeNull();
  });
});
