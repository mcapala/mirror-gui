import { describe, it, expect } from 'vitest';
import {
  queryHub,
  classifyHubError,
  buildSearchRequestBody,
  searchApiUrl,
  SEARCH_RESULT_LIMIT,
} from '../../server/acm/client.js';
import { HubQueryError, type AcmHub } from '../../server/acm/types.js';

const HUB: AcmHub = {
  id: 'h1',
  name: 'prod',
  url: 'https://search.apps.hub.example.com/',
  token: 'sha256~tok',
};

function okResponse(items: unknown[]) {
  return { data: { data: { searchResult: [{ items }] } } };
}

describe('searchApiUrl', () => {
  it('appends /searchapi/graphql and strips trailing slashes', () => {
    expect(searchApiUrl('https://h.example.com/')).toBe(
      'https://h.example.com/searchapi/graphql'
    );
  });
});

describe('buildSearchRequestBody', () => {
  it('filters on ClusterServiceVersion with the default limit', () => {
    const body = buildSearchRequestBody();
    expect(body.variables.input[0].filters).toEqual([
      { property: 'kind', values: ['ClusterServiceVersion'] },
    ]);
    expect(body.variables.input[0].limit).toBe(SEARCH_RESULT_LIMIT);
  });
});

describe('queryHub', () => {
  it('returns items and sends the Bearer token', async () => {
    let seenConfig: Record<string, unknown> = {};
    const transport = {
      post: async (_url: string, _body: unknown, config: never) => {
        seenConfig = config;
        return okResponse([
          { name: 'x.v1.0.0', cluster: 'c1', phase: 'Succeeded' },
        ]);
      },
    };
    const result = await queryHub(HUB, { transport });
    expect(result.items).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect((seenConfig.headers as Record<string, string>).Authorization).toBe(
      'Bearer sha256~tok'
    );
  });

  it('flags truncation when items hit the limit', async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      name: `p.v1.0.${i}`,
      cluster: 'c1',
      phase: 'Succeeded',
    }));
    const transport = { post: async () => okResponse(items) };
    const result = await queryHub(HUB, { transport, limit: 3 });
    expect(result.truncated).toBe(true);
  });

  it('throws bad-response when items array is missing', async () => {
    const transport = { post: async () => ({ data: { data: {} } }) };
    await expect(queryHub(HUB, { transport })).rejects.toMatchObject({
      kind: 'bad-response',
    });
  });

  it('throws bad-response when GraphQL returns errors', async () => {
    const transport = {
      post: async () => ({ data: { errors: [{ message: 'denied' }] } }),
    };
    await expect(queryHub(HUB, { transport })).rejects.toMatchObject({
      kind: 'bad-response',
      message: expect.stringContaining('denied'),
    });
  });

  it('classifies transport failures via classifyHubError', async () => {
    const transport = {
      post: async () => {
        throw Object.assign(new Error('401'), { response: { status: 401 } });
      },
    };
    await expect(queryHub(HUB, { transport })).rejects.toMatchObject({
      kind: 'auth',
    });
  });
});

describe('classifyHubError', () => {
  it('maps HTTP 401/403 to auth', () => {
    const err = Object.assign(new Error('x'), { response: { status: 403 } });
    expect(classifyHubError(err).kind).toBe('auth');
  });

  it('maps TLS error codes to tls', () => {
    const err = Object.assign(new Error('self signed'), {
      code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
    });
    const classified = classifyHubError(err);
    expect(classified.kind).toBe('tls');
    expect(classified.message).toMatch(/CA bundle|skip-verify/);
  });

  it('maps everything else to unreachable', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    expect(classifyHubError(err).kind).toBe('unreachable');
    expect(classifyHubError(err)).toBeInstanceOf(HubQueryError);
  });
});
