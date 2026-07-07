import https from 'https';
import axios from 'axios';
import { RegistryRequestError } from './types.js';

export const REGISTRY_TIMEOUT_MS = 15000;
export const TAGS_PAGE_SIZE = 100;
/** Hard cap on tags/list pagination pages, to bound a registry whose
 * Link: rel="next" header cycles (accidentally or maliciously) back to an
 * already-seen URL. Without this a single misbehaving registry loops
 * forever while holding the per-registry scan single-flight lock. */
export const MAX_TAGS_PAGES = 1000;

export const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
].join(', ');

export interface RegistryResponse {
  status: number;
  headers: Record<string, string | undefined>;
  data: unknown;
}

export interface RegistryTransport {
  request(
    method: 'GET' | 'HEAD',
    url: string,
    config: {
      headers: Record<string, string>;
      httpsAgent?: https.Agent;
      timeout: number;
    },
  ): Promise<RegistryResponse>;
}

const axiosTransport: RegistryTransport = {
  async request(method, url, config) {
    const response = await axios.request({
      method,
      url,
      headers: config.headers,
      httpsAgent: config.httpsAgent,
      timeout: config.timeout,
      validateStatus: () => true,
    });
    const headers: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(response.headers ?? {})) {
      headers[key.toLowerCase()] = value === undefined ? undefined : String(value);
    }
    return { status: response.status, headers, data: response.data };
  },
};

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
]);

export function classifyTransportError(error: unknown): RegistryRequestError {
  const err = error as { code?: string; message?: string };
  if (err?.code && TLS_ERROR_CODES.has(err.code)) {
    return new RegistryRequestError(
      'tls',
      `TLS verification failed (${err.code}) — add the registry CA bundle or enable skip-verify`,
    );
  }
  const detail = err?.code
    ? `${err.code}: ${err.message ?? ''}`
    : (err?.message ?? String(error));
  return new RegistryRequestError(
    'unreachable',
    `registry unreachable — ${detail}`,
  );
}

export function parseLinkNext(
  header: string | undefined,
  baseUrl: string,
): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
    if (match) {
      return new URL(match[1], baseUrl).toString();
    }
  }
  return null;
}

export function parseAuthChallenge(
  header: string | undefined,
): { realm: string; service?: string } | null {
  if (!header || !/^bearer\s/i.test(header)) {
    return null;
  }
  const realm = header.match(/realm="([^"]+)"/)?.[1];
  if (!realm) {
    return null;
  }
  const service = header.match(/service="([^"]+)"/)?.[1];
  return { realm, service };
}

export interface RegistryClientOptions {
  host: string;
  /** base64 user:pass from the pull secret; null only in tests. */
  basicAuth: string | null;
  caBundle?: string;
  insecureSkipVerify?: boolean;
  transport?: RegistryTransport;
  /** http is for tests against a local stub registry only. */
  scheme?: 'https' | 'http';
  timeoutMs?: number;
  /** Overrides MAX_TAGS_PAGES; intended for tests only. */
  maxTagsPages?: number;
}

export interface RegistryClient {
  /** Returns all tags, following pagination; null when the repo is absent. */
  listTags(repo: string): Promise<string[] | null>;
  /** Returns the manifest(-list) digest, or null on 404 / missing header. */
  headManifest(repo: string, tag: string): Promise<string | null>;
  /** Returns all repository paths via /v2/_catalog pagination; null when the
   * registry does not support _catalog (HTTP 404). */
  listRepositories(): Promise<string[] | null>;
}

export function createRegistryClient(
  opts: RegistryClientOptions,
): RegistryClient {
  const transport = opts.transport ?? axiosTransport;
  const scheme = opts.scheme ?? 'https';
  const timeout = opts.timeoutMs ?? REGISTRY_TIMEOUT_MS;
  const maxTagsPages = opts.maxTagsPages ?? MAX_TAGS_PAGES;
  const httpsAgent =
    scheme === 'https'
      ? new https.Agent({
          ca: opts.caBundle || undefined,
          rejectUnauthorized: !opts.insecureSkipVerify,
        })
      : undefined;
  // Bearer tokens are scoped per repository; cache for the client's lifetime
  // (one scan).
  const tokens = new Map<string, string>();

  async function attempt(
    method: 'GET' | 'HEAD',
    url: string,
    headers: Record<string, string>,
  ): Promise<RegistryResponse> {
    try {
      return await transport.request(method, url, {
        headers,
        httpsAgent,
        timeout,
      });
    } catch (error) {
      throw classifyTransportError(error);
    }
  }

  async function send(
    method: 'GET' | 'HEAD',
    url: string,
    repo: string,
    accept?: string,
    scope?: string,
  ): Promise<RegistryResponse> {
    const headers: Record<string, string> = {};
    if (accept) {
      headers.Accept = accept;
    }
    const cached = tokens.get(repo);
    if (cached) {
      headers.Authorization = `Bearer ${cached}`;
    } else if (opts.basicAuth) {
      headers.Authorization = `Basic ${opts.basicAuth}`;
    }
    let response = await attempt(method, url, headers);
    if (response.status === 403) {
      throw new RegistryRequestError(
        'auth',
        `access denied (HTTP 403) for ${repo} — check the pull secret entry`,
      );
    }
    if (response.status !== 401) {
      return response;
    }

    const challenge = parseAuthChallenge(response.headers['www-authenticate']);
    if (!challenge) {
      throw new RegistryRequestError(
        'auth',
        `authentication failed (HTTP 401) for ${repo} — check the pull secret entry`,
      );
    }
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) {
      tokenUrl.searchParams.set('service', challenge.service);
    }
    tokenUrl.searchParams.set('scope', scope ?? `repository:${repo}:pull`);
    const tokenResponse = await attempt(
      'GET',
      tokenUrl.toString(),
      opts.basicAuth ? { Authorization: `Basic ${opts.basicAuth}` } : {},
    );
    const tokenData = tokenResponse.data as
      | { token?: string; access_token?: string }
      | undefined;
    const bearer = tokenData?.token || tokenData?.access_token;
    if (tokenResponse.status !== 200 || !bearer) {
      throw new RegistryRequestError(
        'auth',
        `token exchange failed (HTTP ${tokenResponse.status}) for ${repo} — check the pull secret entry`,
      );
    }
    tokens.set(repo, bearer);
    response = await attempt(method, url, {
      ...headers,
      Authorization: `Bearer ${bearer}`,
    });
    if (response.status === 401 || response.status === 403) {
      throw new RegistryRequestError(
        'auth',
        `authentication failed (HTTP ${response.status}) for ${repo}`,
      );
    }
    return response;
  }

  return {
    async listTags(repo) {
      const tags: string[] = [];
      let url: string | null =
        `${scheme}://${opts.host}/v2/${repo}/tags/list?n=${TAGS_PAGE_SIZE}`;
      const registryOrigin = new URL(`${scheme}://${opts.host}`).origin;
      let pages = 0;
      while (url) {
        pages += 1;
        if (pages > maxTagsPages) {
          throw new RegistryRequestError(
            'bad-response',
            `tags/list pagination for ${repo} exceeded ${maxTagsPages} pages — aborting (possible Link header loop)`,
          );
        }
        const response: RegistryResponse = await send('GET', url, repo);
        if (response.status === 404) {
          return null;
        }
        if (response.status !== 200) {
          throw new RegistryRequestError(
            'bad-response',
            `tags/list returned HTTP ${response.status} for ${repo}`,
          );
        }
        const body = response.data as { tags?: string[] | null } | undefined;
        for (const tag of body?.tags ?? []) {
          tags.push(tag);
        }
        const next = parseLinkNext(response.headers.link, url);
        if (next && new URL(next).origin !== registryOrigin) {
          throw new RegistryRequestError(
            'bad-response',
            `tags/list Link header for ${repo} pointed at a different origin (${new URL(next).origin}) — refusing to follow`,
          );
        }
        url = next;
      }
      return tags;
    },

    async headManifest(repo, tag) {
      const url = `${scheme}://${opts.host}/v2/${repo}/manifests/${tag}`;
      const response = await send('HEAD', url, repo, MANIFEST_ACCEPT);
      if (response.status === 404) {
        return null;
      }
      if (response.status !== 200) {
        throw new RegistryRequestError(
          'bad-response',
          `manifest HEAD returned HTTP ${response.status} for ${repo}:${tag}`,
        );
      }
      return response.headers['docker-content-digest'] ?? null;
    },

    async listRepositories() {
      const repos: string[] = [];
      let url: string | null =
        `${scheme}://${opts.host}/v2/_catalog?n=${TAGS_PAGE_SIZE}`;
      const registryOrigin = new URL(`${scheme}://${opts.host}`).origin;
      let pages = 0;
      while (url) {
        pages += 1;
        if (pages > maxTagsPages) {
          throw new RegistryRequestError(
            'bad-response',
            `_catalog pagination exceeded ${maxTagsPages} pages — aborting (possible Link header loop)`,
          );
        }
        const response: RegistryResponse = await send(
          'GET',
          url,
          '_catalog',
          undefined,
          'registry:catalog:*',
        );
        if (response.status === 404) {
          return null;
        }
        if (response.status !== 200) {
          throw new RegistryRequestError(
            'bad-response',
            `_catalog returned HTTP ${response.status}`,
          );
        }
        const body = response.data as
          | { repositories?: unknown }
          | undefined;
        if (!Array.isArray(body?.repositories)) {
          throw new RegistryRequestError(
            'bad-response',
            '_catalog response is missing a "repositories" array',
          );
        }
        for (const repo of body.repositories) {
          if (typeof repo === 'string') {
            repos.push(repo);
          }
        }
        const next = parseLinkNext(response.headers.link, url);
        if (next && new URL(next).origin !== registryOrigin) {
          throw new RegistryRequestError(
            'bad-response',
            `_catalog Link header pointed at a different origin (${new URL(next).origin}) — refusing to follow`,
          );
        }
        url = next;
      }
      return repos;
    },
  };
}
