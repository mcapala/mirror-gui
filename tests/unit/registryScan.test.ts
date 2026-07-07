import { describe, it, expect } from 'vitest';
import {
  buildOperatorContent,
  deriveExpectations,
  executeScan,
  joinRepoPath,
  stripImageRef,
  type ScanClientLike,
} from '../../server/registry/scan.js';
import {
  RegistryRequestError,
  type CatalogBundles,
  type RegistryScanSnapshot,
} from '../../server/registry/types.js';

const CATALOG = 'redhat-operator-index:v4.21';

function catalogBundles(): CatalogBundles[] {
  return [
    {
      catalog: CATALOG,
      bundles: {
        schemaVersion: 1,
        packages: {
          'advanced-cluster-management': {
            bundles: {
              'advanced-cluster-management.v2.16.0': {
                version: '2.16.0',
                image:
                  'registry.redhat.io/rhacm2/acm-operator-bundle@sha256:aaa',
                relatedImages: [],
              },
              'advanced-cluster-management.v2.15.0': {
                version: '2.15.0',
                image:
                  'registry.redhat.io/rhacm2/acm-operator-bundle@sha256:bbb',
                relatedImages: [],
              },
            },
            channels: {},
          },
          'community-op': {
            bundles: {
              'community-op.v1.0.0': {
                version: '1.0.0',
                image: 'quay.io/community/op-bundle:v1.0.0',
                relatedImages: [],
              },
            },
            channels: {},
          },
        },
      },
    },
  ];
}

describe('stripImageRef', () => {
  it('splits host, path, and digest', () => {
    expect(
      stripImageRef('registry.redhat.io/rhacm2/acm-operator-bundle@sha256:abc'),
    ).toEqual({
      path: 'rhacm2/acm-operator-bundle',
      digest: 'sha256:abc',
      tag: null,
    });
  });

  it('splits host, path, and tag; host port is not a tag', () => {
    expect(stripImageRef('quay.io/community/op-bundle:v1.0.0')).toEqual({
      path: 'community/op-bundle',
      digest: null,
      tag: 'v1.0.0',
    });
    expect(stripImageRef('reg.example:8443/ns/repo:v1')).toEqual({
      path: 'ns/repo',
      digest: null,
      tag: 'v1',
    });
  });

  it('digest wins when a ref carries both tag and digest', () => {
    expect(stripImageRef('reg.example/ns/repo:v1@sha256:abc')).toEqual({
      path: 'ns/repo',
      digest: 'sha256:abc',
      tag: null,
    });
  });

  it('returns null for refs without a host segment', () => {
    expect(stripImageRef('just-a-name')).toBeNull();
  });
});

describe('joinRepoPath', () => {
  it('handles root, single, and multi-segment prefixes', () => {
    expect(joinRepoPath('', 'rhacm2/acm-operator-bundle')).toBe(
      'rhacm2/acm-operator-bundle',
    );
    expect(joinRepoPath('mirror', 'rhacm2/acm-operator-bundle')).toBe(
      'mirror/rhacm2/acm-operator-bundle',
    );
    expect(joinRepoPath('mirror/prod', 'rhacm2/acm-operator-bundle')).toBe(
      'mirror/prod/rhacm2/acm-operator-bundle',
    );
  });
});

describe('deriveExpectations', () => {
  it('maps digests and tags per rewritten repo', () => {
    const expectations = deriveExpectations(catalogBundles(), 'mirror');
    const acm = expectations.get('mirror/rhacm2/acm-operator-bundle')!;
    expect(acm.byDigest.get('sha256:aaa')).toMatchObject({
      package: 'advanced-cluster-management',
      bundleName: 'advanced-cluster-management.v2.16.0',
      version: '2.16.0',
      catalog: CATALOG,
    });
    expect(acm.byDigest.get('sha256:bbb')).toBeDefined();
    const community = expectations.get('mirror/community/op-bundle')!;
    expect(community.byTag.get('v1.0.0')).toMatchObject({
      package: 'community-op',
      version: '1.0.0',
    });
  });

  it('merges colliding repos from different source hosts', () => {
    const catalogs: CatalogBundles[] = [
      {
        catalog: CATALOG,
        bundles: {
          schemaVersion: 1,
          packages: {
            a: {
              bundles: {
                'a.v1': {
                  version: '1',
                  image: 'registry.redhat.io/ns/shared@sha256:one',
                  relatedImages: [],
                },
              },
              channels: {},
            },
            b: {
              bundles: {
                'b.v1': {
                  version: '1',
                  image: 'quay.io/ns/shared@sha256:two',
                  relatedImages: [],
                },
              },
              channels: {},
            },
          },
        },
      },
    ];
    const expectations = deriveExpectations(catalogs, '');
    expect(expectations.size).toBe(1);
    const shared = expectations.get('ns/shared')!;
    expect(shared.byDigest.get('sha256:one')!.package).toBe('a');
    expect(shared.byDigest.get('sha256:two')!.package).toBe('b');
  });
});

describe('executeScan', () => {
  function client(overrides: Partial<ScanClientLike>): ScanClientLike {
    return {
      listTags: async () => null,
      headManifest: async () => null,
      ...overrides,
    };
  }

  it('joins on digest, falls back to tag, flags unknown', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(
      expectations,
      client({
        listTags: async repo => {
          if (repo === 'rhacm2/acm-operator-bundle') return ['t1', 't-drift'];
          if (repo === 'community/op-bundle') return ['v1.0.0'];
          return null;
        },
        headManifest: async (_repo, tag) => {
          if (tag === 't1') return 'sha256:aaa';
          if (tag === 't-drift') return 'sha256:zzz';
          return null; // community registry without digest header
        },
      }),
    );
    const acm = result.repos.find(
      r => r.repo === 'rhacm2/acm-operator-bundle',
    )!;
    expect(acm.tags.find(t => t.tag === 't1')!.matched!.version).toBe('2.16.0');
    expect(acm.tags.find(t => t.tag === 't-drift')!.matched).toBeNull();
    const community = result.repos.find(
      r => r.repo === 'community/op-bundle',
    )!;
    expect(community.tags[0].matched!.package).toBe('community-op');
    expect(community.tags[0].digest).toBeNull();
    expect(result.stats).toEqual({
      reposExpected: 2,
      reposPresent: 2,
      tagsScanned: 3,
      matched: 2,
      unknown: 1,
    });
    expect(result.errors).toEqual([]);
  });

  it('records absent repos without error', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(expectations, client({}));
    expect(result.repos.every(r => r.present === false)).toBe(true);
    expect(result.stats.reposPresent).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('collects per-repo errors and continues', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(
      expectations,
      client({
        listTags: async repo => {
          if (repo === 'rhacm2/acm-operator-bundle') {
            throw new RegistryRequestError('auth', 'denied');
          }
          return ['v1.0.0'];
        },
        headManifest: async () => null,
      }),
    );
    expect(result.errors).toEqual([
      {
        repo: 'rhacm2/acm-operator-bundle',
        catalog: null,
        kind: 'auth',
        message: 'denied',
      },
    ]);
    expect(
      result.repos.find(r => r.repo === 'community/op-bundle'),
    ).toBeDefined();
  });
});

describe('buildOperatorContent', () => {
  it('groups matched tags per package and lists unknown tags', () => {
    const snapshot: RegistryScanSnapshot = {
      schemaVersion: 1,
      registryId: 'r1',
      host: 'reg.example',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-07T12:00:00.000Z',
      partial: false,
      catalogs: [CATALOG],
      repos: [
        {
          repo: 'mirror/rhacm2/acm-operator-bundle',
          present: true,
          tags: [
            {
              tag: 't2',
              digest: 'sha256:aaa',
              matched: {
                package: 'advanced-cluster-management',
                bundleName: 'advanced-cluster-management.v2.16.0',
                version: '2.16.0',
                catalog: CATALOG,
              },
            },
            {
              tag: 't1',
              digest: 'sha256:bbb',
              matched: {
                package: 'advanced-cluster-management',
                bundleName: 'advanced-cluster-management.v2.15.0',
                version: '2.15.0',
                catalog: CATALOG,
              },
            },
            { tag: 'weird', digest: 'sha256:zzz', matched: null },
          ],
        },
      ],
      errors: [],
      stats: {
        reposExpected: 1,
        reposPresent: 1,
        tagsScanned: 3,
        matched: 2,
        unknown: 1,
      },
    };
    const report = buildOperatorContent(snapshot);
    const versions = report.packages['advanced-cluster-management'];
    expect(versions.map(v => v.version)).toEqual(['2.15.0', '2.16.0']);
    expect(report.unknownTags).toEqual([
      {
        repo: 'mirror/rhacm2/acm-operator-bundle',
        tag: 'weird',
        digest: 'sha256:zzz',
      },
    ]);
    expect(report.stats.unknown).toBe(1);
  });
});
