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
  hasContentType: boolean;
  body: unknown;
}

interface FetchState {
  calls: Captured[];
  readonly first: Captured;
}

function stubFetch(res: Response): FetchState {
  const calls: Captured[] = [];
  global.fetch = ((url: string, init: RequestInit = {}) => {
    const headers = (init.headers as Record<string, string> | undefined) ?? {};
    calls.push({
      url,
      method: init.method,
      authorization: headers.Authorization,
      hasContentType: 'Content-Type' in headers,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    });
    return Promise.resolve(res);
  }) as unknown as typeof fetch;
  return {
    calls,
    get first(): Captured {
      const call = calls[0];
      if (!call) {
        throw new Error('fetch was never called');
      }
      return call;
    },
  };
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
    expect(state.calls).toHaveLength(0);
  });

  it('preserve() POSTs {cid} (no name) to <endpoint>/pins with a Bearer token, returns requestid', async () => {
    const state = stubFetch(
      response({ ok: true, status: 202, body: { requestid: 'req_abc', status: 'queued' } }),
    );

    const result = await new FilebasePreservationAdapter(configWith({})).preserve(request);

    expect(result).toEqual({ requestId: 'req_abc' });
    expect(state.first).toEqual({
      url: 'https://api.filebase.io/v1/ipfs/pins',
      method: 'POST',
      authorization: 'Bearer tok_test',
      hasContentType: true,
      body: { cid: request.cid }, // no `name` — Filebase 409 is a name conflict (검증 문제 1)
    });
  });

  it('preserve() does NOT treat 409 as success — it throws like any other non-2xx (검증 문제 1)', async () => {
    stubFetch(response({ ok: false, status: 409, text: 'NAMING CONFLICT' }));
    await expect(new FilebasePreservationAdapter(configWith({})).preserve(request)).rejects.toThrow(
      /Filebase POST \/pins failed: HTTP 409/,
    );
  });

  it('preserve() throws when the response has no requestid', async () => {
    stubFetch(response({ ok: true, status: 202, body: { status: 'queued' } }));
    await expect(new FilebasePreservationAdapter(configWith({})).preserve(request)).rejects.toThrow(
      /did not include a requestid/,
    );
  });

  it('checkStatus() GETs /pins/{requestId} and returns the pin state', async () => {
    const state = stubFetch(response({ ok: true, status: 200, body: { status: 'pinned' } }));
    const result = await new FilebasePreservationAdapter(configWith({})).checkStatus('req abc/1');
    expect(result).toBe('pinned');
    expect(state.first.method).toBe('GET');
    expect(state.first.url).toBe('https://api.filebase.io/v1/ipfs/pins/req%20abc%2F1');
    expect(state.first.hasContentType).toBe(false);
  });

  it('checkStatus() rejects an unexpected status value', async () => {
    stubFetch(response({ ok: true, status: 200, body: { status: 'exploded' } }));
    await expect(new FilebasePreservationAdapter(configWith({})).checkStatus('req')).rejects.toThrow(
      /unexpected status: exploded/,
    );
  });

  it('honours a custom FILEBASE_PIN_ENDPOINT and trims a trailing slash', async () => {
    const state = stubFetch(response({ ok: true, status: 200, body: { requestid: 'r' } }));
    await new FilebasePreservationAdapter(
      configWith({ filebasePinEndpoint: 'https://ipfs.filebase.io/v1/ipfs/' }),
    ).preserve(request);
    expect(state.first.url).toBe('https://ipfs.filebase.io/v1/ipfs/pins');
  });
});
