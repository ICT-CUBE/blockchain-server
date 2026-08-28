import type { AppConfigService } from '../../../shared/config/app-config.service';
import type { PreserveRequest } from '../application/preservation.port';
import { FilebaseNotConfiguredError, FilebasePreservationAdapter } from './filebase-preservation.adapter';

function configWith(metadata: Partial<AppConfigService['metadata']>): AppConfigService {
  return {
    metadata: {
      provider: 'real',
      pinataJwt: null,
      filebasePinToken: 'tok_test',
      filebasePinEndpoint: 'https://api.filebase.io/v1/ipfs',
      httpTimeoutMs: 15000,
      imageMaxBytes: 2 * 1024 * 1024,
      ...metadata,
    },
  } as AppConfigService;
}

function response(init: { ok: boolean; status: number; body?: unknown; text?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: () => Promise.resolve(init.body ?? {}),
    text: () => Promise.resolve(init.text ?? ''),
  } as unknown as Response;
}

interface Captured {
  url: string;
  method?: string;
  authorization?: string;
  body: unknown;
}

/** Installs a `global.fetch` stub returning `res`, and captures the first call's args. */
function stubFetch(res: Response): { captured: Captured | null } {
  const state: { captured: Captured | null } = { captured: null };
  global.fetch = ((url: string, init: RequestInit = {}) => {
    state.captured = {
      url,
      method: init.method,
      authorization: (init.headers as Record<string, string> | undefined)?.Authorization,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    };
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return state;
}

const request: PreserveRequest = {
  cid: 'bafkreigh2akiscaildc',
  chainId: 80002,
  contractAddress: '0x0000000000000000000000000000000000000001',
  tokenId: 421,
};

describe('FilebasePreservationAdapter', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('throws FilebaseNotConfiguredError when the token is missing (no HTTP call)', async () => {
    const state = stubFetch(response({ ok: true, status: 200 }));
    const adapter = new FilebasePreservationAdapter(configWith({ filebasePinToken: null }));
    await expect(adapter.preserve(request)).rejects.toBeInstanceOf(FilebaseNotConfiguredError);
    expect(state.captured).toBeNull();
  });

  it('POSTs {cid,name} to <endpoint>/pins with a Bearer token and returns requestid as evidence', async () => {
    const state = stubFetch(response({ ok: true, status: 202, body: { requestid: 'req_abc' } }));

    const result = await new FilebasePreservationAdapter(configWith({})).preserve(request);

    expect(result).toEqual({ evidenceId: 'req_abc' });
    expect(state.captured).toEqual({
      url: 'https://api.filebase.io/v1/ipfs/pins',
      method: 'POST',
      authorization: 'Bearer tok_test',
      body: { cid: request.cid, name: 'cube-421' },
    });
  });

  it('treats HTTP 409 (already pinned on this bucket) as idempotent success', async () => {
    stubFetch(response({ ok: false, status: 409 }));
    const result = await new FilebasePreservationAdapter(configWith({})).preserve(request);
    expect(result).toEqual({ evidenceId: `filebase:${request.cid}` });
  });

  it('rejects on any other non-2xx with the status in the message', async () => {
    stubFetch(response({ ok: false, status: 401, text: 'bad token' }));
    await expect(new FilebasePreservationAdapter(configWith({})).preserve(request)).rejects.toThrow(
      /Filebase \/pins failed: HTTP 401/,
    );
  });

  it('honours a custom FILEBASE_PIN_ENDPOINT and trims a trailing slash', async () => {
    const state = stubFetch(response({ ok: true, status: 200, body: { requestid: 'r' } }));
    await new FilebasePreservationAdapter(
      configWith({ filebasePinEndpoint: 'https://ipfs.filebase.io/v1/ipfs/' }),
    ).preserve(request);
    expect(state.captured?.url).toBe('https://ipfs.filebase.io/v1/ipfs/pins');
  });
});
