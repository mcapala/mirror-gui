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
});
