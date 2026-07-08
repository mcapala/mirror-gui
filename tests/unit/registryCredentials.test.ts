import { describe, it, expect } from 'vitest';
import { resolveRegistryCredentials } from '../../server/registry/credentials.js';

const AUTHS = { 'quay.local:8443': { auth: 'cHVsbDpzZWNyZXQ=' } };

describe('resolveRegistryCredentials', () => {
  it('prefers stored username/password over a pull-secret match', () => {
    const resolved = resolveRegistryCredentials(
      { host: 'quay.local:8443', username: 'user', password: 'pass' },
      AUTHS,
    );
    expect(resolved).toEqual({
      basicAuth: Buffer.from('user:pass').toString('base64'),
      source: 'local',
    });
  });

  it('falls back to the pull-secret auth for the exact host', () => {
    expect(
      resolveRegistryCredentials({ host: 'quay.local:8443' }, AUTHS),
    ).toEqual({ basicAuth: 'cHVsbDpzZWNyZXQ=', source: 'pull-secret' });
  });

  it('is anonymous when neither source has credentials', () => {
    expect(
      resolveRegistryCredentials({ host: 'other.example' }, AUTHS),
    ).toEqual({ basicAuth: null, source: 'none' });
    expect(resolveRegistryCredentials({ host: 'other.example' }, null)).toEqual(
      { basicAuth: null, source: 'none' },
    );
  });

  it('treats half-set stored credentials as absent (fallback applies)', () => {
    expect(
      resolveRegistryCredentials(
        { host: 'quay.local:8443', username: 'user' },
        AUTHS,
      ).source,
    ).toBe('pull-secret');
    expect(
      resolveRegistryCredentials(
        { host: 'other.example', password: 'pass' },
        AUTHS,
      ).source,
    ).toBe('none');
  });
});
