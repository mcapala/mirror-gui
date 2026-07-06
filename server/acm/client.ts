import https from 'https';
import axios from 'axios';
import {
  HubQueryError,
  type AcmHub,
  type CsvSearchItem,
  type HubQueryResult,
} from './types.js';

export const SEARCH_RESULT_LIMIT = 10000;
export const HUB_TIMEOUT_MS = 30000;

export interface Transport {
  post(
    url: string,
    body: unknown,
    config: Record<string, unknown>
  ): Promise<{ data: unknown }>;
}

const SEARCH_QUERY = `query mySearch($input: [SearchInput]) {
  searchResult: search(input: $input) {
    items
  }
}`;

export function searchApiUrl(hubUrl: string): string {
  return `${hubUrl.replace(/\/+$/, '')}/searchapi/graphql`;
}

export function buildSearchRequestBody(limit: number = SEARCH_RESULT_LIMIT) {
  return {
    query: SEARCH_QUERY,
    variables: {
      input: [
        {
          filters: [{ property: 'kind', values: ['ClusterServiceVersion'] }],
          limit,
        },
      ],
    },
  };
}

const TLS_ERROR_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
]);

export function classifyHubError(error: unknown): HubQueryError {
  const err = error as {
    response?: { status?: number };
    code?: string;
    message?: string;
  };
  const status = err?.response?.status;
  if (status === 401 || status === 403) {
    return new HubQueryError(
      'auth',
      `authentication failed (HTTP ${status}) — check the hub token`
    );
  }
  if (err?.code && TLS_ERROR_CODES.has(err.code)) {
    return new HubQueryError(
      'tls',
      `TLS verification failed (${err.code}) — add the hub CA bundle or enable skip-verify`
    );
  }
  const detail = err?.code
    ? `${err.code}: ${err.message ?? ''}`
    : (err?.message ?? String(error));
  return new HubQueryError('unreachable', `hub unreachable — ${detail}`);
}

export async function queryHub(
  hub: AcmHub,
  opts: { limit?: number; transport?: Transport } = {}
): Promise<HubQueryResult> {
  const limit = opts.limit ?? SEARCH_RESULT_LIMIT;
  const transport = opts.transport ?? axios;
  const httpsAgent = new https.Agent({
    ca: hub.caBundle || undefined,
    rejectUnauthorized: !hub.insecureSkipVerify,
  });

  let response: { data: unknown };
  try {
    response = await transport.post(
      searchApiUrl(hub.url),
      buildSearchRequestBody(limit),
      {
        headers: {
          Authorization: `Bearer ${hub.token}`,
          'Content-Type': 'application/json',
        },
        httpsAgent,
        timeout: HUB_TIMEOUT_MS,
      }
    );
  } catch (error) {
    throw classifyHubError(error);
  }

  const data = response.data as {
    data?: { searchResult?: Array<{ items?: unknown }> };
    errors?: Array<{ message?: string }>;
  };
  if (data?.errors?.length) {
    throw new HubQueryError(
      'bad-response',
      `Search API returned an error: ${data.errors[0]?.message ?? 'unknown'}`
    );
  }
  const items = data?.data?.searchResult?.[0]?.items;
  if (!Array.isArray(items)) {
    throw new HubQueryError(
      'bad-response',
      'Search API response did not contain an items array'
    );
  }
  return {
    items: items as CsvSearchItem[],
    truncated: items.length >= limit,
  };
}
