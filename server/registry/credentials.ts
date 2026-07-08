import type { MirrorRegistryConfig } from './types.js';

export type CredentialSource = 'local' | 'pull-secret' | 'none';

export interface ResolvedCredentials {
  basicAuth: string | null;
  source: CredentialSource;
}

/** Stored username/password wins; else the pull-secret entry for the exact
 * host; else anonymous. */
export function resolveRegistryCredentials(
  registry: Pick<MirrorRegistryConfig, 'host' | 'username' | 'password'>,
  auths: Record<string, { auth?: string }> | null,
): ResolvedCredentials {
  if (registry.username && registry.password) {
    return {
      basicAuth: Buffer.from(
        `${registry.username}:${registry.password}`,
      ).toString('base64'),
      source: 'local',
    };
  }
  const auth = auths?.[registry.host]?.auth;
  if (auth) {
    return { basicAuth: auth, source: 'pull-secret' };
  }
  return { basicAuth: null, source: 'none' };
}
