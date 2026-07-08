import { describe, it, expect } from 'vitest';
import {
  createRegistryClient,
  parseAuthChallenge,
  parseLinkNext,
  type RegistryResponse,
  type RegistryTransport,
} from '../../server/registry/client.js';
import { RegistryRequestError } from '../../server/registry/types.js';

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** Transport scripted by URL substring match, recording every request. */
function fakeTransport(
  script: Array<{
    match: (method: string, url: string) => boolean;
    response: RegistryResponse;
  }>,
): { transport: RegistryTransport; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    transport: {
      async request(method, url, config) {
        requests.push({ method, url, headers: config.headers });
        const hit = script.find(s => s.match(method, url));
        if (!hit) throw new Error(`unexpected request: ${method} ${url}`);
        return hit.response;
      },
    },
  };
}

const ok = (data: unknown, headers: Record<string, string | undefined> = {}) =>
  ({ status: 200, headers, data }) as RegistryResponse;

describe('parseLinkNext', () => {
  it('resolves a relative next URL against the base', () => {
    expect(
      parseLinkNext(
        '</v2/foo/tags/list?last=x&n=100>; rel="next"',
        'https://reg.example:8443/v2/foo/tags/list?n=100',
      ),
    ).toBe('https://reg.example:8443/v2/foo/tags/list?last=x&n=100');
  });

  it('passes through an absolute next URL', () => {
    expect(
      parseLinkNext(
        '<https://other.example/v2/foo/tags/list?last=y>; rel="next"',
        'https://reg.example/v2/foo/tags/list',
      ),
    ).toBe('https://other.example/v2/foo/tags/list?last=y');
  });

  it('returns null when absent or not rel=next', () => {
    expect(parseLinkNext(undefined, 'https://reg.example/')).toBeNull();
    expect(
      parseLinkNext('<...>; rel="prev"', 'https://reg.example/'),
    ).toBeNull();
  });
});

describe('parseAuthChallenge', () => {
  it('extracts realm and service from a Bearer challenge', () => {
    expect(
      parseAuthChallenge(
        'Bearer realm="https://reg.example/token",service="reg.example"',
      ),
    ).toEqual({ realm: 'https://reg.example/token', service: 'reg.example' });
  });

  it('returns null for Basic challenges or missing realm', () => {
    expect(parseAuthChallenge('Basic realm="x"')).toBeNull();
    expect(parseAuthChallenge(undefined)).toBeNull();
  });
});

describe('createRegistryClient', () => {
  it('paginates tags/list until the Link header is absent', async () => {
    const { transport } = fakeTransport([
      {
        match: (_m, url) => url.includes('tags/list') && !url.includes('last='),
        response: ok(
          { name: 'foo', tags: ['a', 'b'] },
          { link: '</v2/foo/tags/list?last=b&n=100>; rel="next"' },
        ),
      },
      {
        match: (_m, url) => url.includes('last=b'),
        response: ok({ name: 'foo', tags: ['c'] }),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    expect(await client.listTags('foo')).toEqual(['a', 'b', 'c']);
  });

  it('returns null for an absent repo (404)', async () => {
    const { transport } = fakeTransport([
      {
        match: () => true,
        response: { status: 404, headers: {}, data: { errors: [] } },
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    expect(await client.listTags('gone/repo')).toBeNull();
  });

  it('performs the 401 → token → retry flow with repo pull scope', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: (_m, url) =>
          url.includes('tags/list') &&
          !requests.some(r => r.url.includes('/token')),
        response: {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://reg.example/token",service="reg.example"',
          },
          data: null,
        },
      },
      {
        match: (_m, url) => url.includes('/token'),
        response: ok({ token: 'tok123' }),
      },
      {
        match: (_m, url) => url.includes('tags/list'),
        response: ok({ tags: ['a'] }),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    expect(await client.listTags('ns/repo')).toEqual(['a']);

    const tokenReq = requests.find(r => r.url.includes('/token'))!;
    expect(tokenReq.url).toContain('service=reg.example');
    expect(tokenReq.url).toContain(
      `scope=${encodeURIComponent('repository:ns/repo:pull')}`,
    );
    expect(tokenReq.headers.Authorization).toBe('Basic dXNlcjpwYXNz');
    const retry = requests[requests.length - 1];
    expect(retry.headers.Authorization).toBe('Bearer tok123');
  });

  it('throws an auth error when the token endpoint fails', async () => {
    const { transport } = fakeTransport([
      {
        match: (_m, url) => url.includes('tags/list'),
        response: {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://reg.example/token",service="reg.example"',
          },
          data: null,
        },
      },
      {
        match: (_m, url) => url.includes('/token'),
        response: { status: 500, headers: {}, data: null },
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'auth',
    });
  });

  it('throws an auth error when the token response has no token field', async () => {
    const { transport } = fakeTransport([
      {
        match: (_m, url) => url.includes('tags/list'),
        response: {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://reg.example/token",service="reg.example"',
          },
          data: null,
        },
      },
      {
        match: (_m, url) => url.includes('/token'),
        response: ok({ issued_at: '2026-07-07T00:00:00Z' }),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'auth',
    });
  });

  it('throws an auth error on 401 without a Bearer challenge', async () => {
    const { transport } = fakeTransport([
      { match: () => true, response: { status: 401, headers: {}, data: null } },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'auth',
    });
  });

  it('headManifest sends the manifest-list Accept set and returns the digest', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: m => m === 'HEAD',
        response: {
          status: 200,
          headers: { 'docker-content-digest': 'sha256:abc' },
          data: null,
        },
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    expect(await client.headManifest('foo', 'v1')).toBe('sha256:abc');
    expect(requests[0].headers.Accept).toContain(
      'application/vnd.docker.distribution.manifest.list.v2+json',
    );
    expect(requests[0].headers.Accept).toContain(
      'application/vnd.oci.image.index.v1+json',
    );
  });

  it('headManifest returns null on 404 or missing digest header', async () => {
    const { transport } = fakeTransport([
      {
        match: (_m, url) => url.includes('/manifests/gone'),
        response: { status: 404, headers: {}, data: null },
      },
      {
        match: (_m, url) => url.includes('/manifests/nodigest'),
        response: { status: 200, headers: {}, data: null },
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    expect(await client.headManifest('foo', 'gone')).toBeNull();
    expect(await client.headManifest('foo', 'nodigest')).toBeNull();
  });

  it('classifies TLS transport failures', async () => {
    const transport: RegistryTransport = {
      async request() {
        const err = new Error('self signed') as Error & { code: string };
        err.code = 'DEPTH_ZERO_SELF_SIGNED_CERT';
        throw err;
      },
    };
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      kind: 'tls',
    });
  });

  it('throws bad-response on unexpected tags/list status', async () => {
    const { transport } = fakeTransport([
      { match: () => true, response: { status: 500, headers: {}, data: null } },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toBeInstanceOf(
      RegistryRequestError,
    );
    await expect(client.listTags('foo')).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('rejects with bad-response when tags/list Link header loops back on itself', async () => {
    const { transport } = fakeTransport([
      {
        match: (_m, url) => url.includes('tags/list'),
        response: ok(
          { name: 'foo', tags: ['a'] },
          { link: '</v2/foo/tags/list?last=b&n=100>; rel="next"' },
        ),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
      maxTagsPages: 3,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'bad-response',
    });
  });

  it('rejects and never sends a request when tags/list Link points at a different origin', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: (_m, url) => url.includes('reg.example') && url.includes('tags/list'),
        response: ok(
          { name: 'foo', tags: ['a'] },
          { link: '<https://evil.example/v2/foo/tags/list?last=b>; rel="next"' },
        ),
      },
      {
        match: (_m, url) => url.includes('evil.example'),
        response: ok({ name: 'foo', tags: ['b'] }),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.listTags('foo')).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'bad-response',
    });
    expect(requests.some(r => r.url.includes('evil.example'))).toBe(false);
  });
});

describe('ping', () => {
  it('resolves on HTTP 200 with basic auth', async () => {
    const { transport, requests } = fakeTransport([
      { match: (_m, url) => url.endsWith('/v2/'), response: ok({}) },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.ping()).resolves.toBeUndefined();
    expect(requests[0].headers.Authorization).toBe('Basic dXNlcjpwYXNz');
  });

  it('follows a bearer challenge without a repository scope', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: (_m, url) =>
          url.endsWith('/v2/') &&
          !requests.some(r => r.url.includes('/token')),
        response: {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://reg.example/token",service="reg"',
          },
          data: {},
        },
      },
      {
        match: (_m, url) => url.includes('/token'),
        response: ok({ token: 'tok' }),
      },
      { match: (_m, url) => url.endsWith('/v2/'), response: ok({}) },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'dXNlcjpwYXNz',
      transport,
    });
    await expect(client.ping()).resolves.toBeUndefined();
    const tokenCall = requests.find(r => r.url.includes('/token'));
    expect(tokenCall!.url).not.toContain('scope=');
    const retry = requests[requests.length - 1];
    expect(retry.headers.Authorization).toBe('Bearer tok');
  });

  it('throws kind auth on 401 without a challenge', async () => {
    const { transport } = fakeTransport([
      { match: () => true, response: { status: 401, headers: {}, data: {} } },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    await expect(client.ping()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('throws kind bad-response on unexpected status', async () => {
    const { transport } = fakeTransport([
      { match: () => true, response: { status: 500, headers: {}, data: {} } },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    await expect(client.ping()).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });
});

describe('listRepositories', () => {
  it('paginates /v2/_catalog until the Link header is absent', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: (_m, url) => url.includes('/v2/_catalog') && !url.includes('last='),
        response: ok(
          { repositories: ['mirror/a', 'mirror/b'] },
          { link: '</v2/_catalog?last=mirror%2Fb&n=100>; rel="next"' },
        ),
      },
      {
        match: (_m, url) => url.includes('last='),
        response: ok({ repositories: ['mirror/c'] }),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    expect(await client.listRepositories()).toEqual([
      'mirror/a',
      'mirror/b',
      'mirror/c',
    ]);
    expect(requests).toHaveLength(2);
  });

  it('requests a catalog-scoped token on a 401 challenge', async () => {
    const { transport, requests } = fakeTransport([
      {
        match: (_m, url) =>
          url.includes('/v2/_catalog') && !url.includes('token'),
        response: {
          status: 401,
          headers: {
            'www-authenticate':
              'Bearer realm="https://reg.example/token",service="reg"',
          },
          data: {},
        },
      },
      {
        match: (_m, url) => url.includes('/token'),
        response: ok({ token: 'cat-token' }),
      },
    ]);
    // Second /v2/_catalog attempt (with Bearer) must succeed:
    const script2 = {
      match: (_m: string, url: string) => url.includes('/v2/_catalog'),
      response: ok({ repositories: [] }),
    };
    let first = true;
    const wrapped: RegistryTransport = {
      async request(method, url, config) {
        if (url.includes('/v2/_catalog') && !first) {
          requests.push({ method, url, headers: config.headers });
          return script2.response;
        }
        if (url.includes('/v2/_catalog')) first = false;
        return transport.request(method, url, config);
      },
    };
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: 'YmFzaWM=',
      transport: wrapped,
    });
    expect(await client.listRepositories()).toEqual([]);
    const tokenReq = requests.find(r => r.url.includes('/token'));
    expect(tokenReq?.url).toContain('scope=registry%3Acatalog%3A*');
  });

  it('returns null when _catalog is unsupported (404)', async () => {
    const { transport } = fakeTransport([
      {
        match: () => true,
        response: { status: 404, headers: {}, data: {} },
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    expect(await client.listRepositories()).toBeNull();
  });

  it('throws bad-response on a body without a repositories array', async () => {
    const { transport } = fakeTransport([
      { match: () => true, response: ok({ nope: true }) },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    await expect(client.listRepositories()).rejects.toMatchObject({
      name: 'RegistryRequestError',
      kind: 'bad-response',
    });
  });

  it('throws bad-response when pagination exceeds the page cap', async () => {
    const { transport } = fakeTransport([
      {
        match: () => true,
        response: ok(
          { repositories: ['x'] },
          { link: '</v2/_catalog?last=x&n=100>; rel="next"' },
        ),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
      maxTagsPages: 3,
    });
    await expect(client.listRepositories()).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('refuses a cross-origin _catalog Link next URL', async () => {
    const { transport } = fakeTransport([
      {
        match: () => true,
        response: ok(
          { repositories: ['x'] },
          { link: '<https://evil.example/v2/_catalog?last=x>; rel="next"' },
        ),
      },
    ]);
    const client = createRegistryClient({
      host: 'reg.example',
      basicAuth: null,
      transport,
    });
    await expect(client.listRepositories()).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });
});
