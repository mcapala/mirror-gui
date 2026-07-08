import { describe, it, expect } from 'vitest';
import {
  buildOperatorContent,
  buildScanTargets,
  deriveAdditionalExpectations,
  deriveExpectations,
  derivePlatformRepos,
  deriveSupportRepos,
  executeScan,
  joinRepoPath,
  stripImageRef,
  type ScanClientLike,
  type ScanTarget,
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
      buildScanTargets(expectations, new Map(), []),
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
      reposAdditional: 0,
      reposWalked: 0,
      reposSupport: 0,
      reposPlatform: 0,
    });
    expect(result.errors).toEqual([]);
  });

  it('counts support and platform targets in stats', async () => {
    const targets = buildScanTargets(
      new Map(),
      new Map(),
      ['a/support-repo', 'b/platform-repo', 'c/orphan'],
      new Set(['a/support-repo']),
      new Set(['b/platform-repo']),
    );
    const result = await executeScan(
      targets,
      client({ listTags: async () => ['v1'], headManifest: async () => null }),
    );
    expect(result.stats.reposSupport).toBe(1);
    expect(result.stats.reposPlatform).toBe(1);
    expect(result.stats.reposWalked).toBe(1);
  });

  it('treats a per-repo auth failure as an absent repo (registries hide unknown repos behind 401)', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(
      buildScanTargets(expectations, new Map(), []),
      client({
        listTags: async repo => {
          if (repo === 'rhacm2/acm-operator-bundle') return ['t1'];
          throw new RegistryRequestError(
            'auth',
            `authentication failed (HTTP 401) for ${repo}`,
          );
        },
        headManifest: async () => 'sha256:aaa',
      }),
    );
    const denied = result.repos.find(r => r.repo === 'community/op-bundle')!;
    expect(denied.present).toBe(false);
    expect(denied.tags).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.stats.reposPresent).toBe(1);
  });

  it('ignores cosign signature/attestation/sbom tags entirely', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const sigTag = `sha256-${'b'.repeat(64)}.sig`;
    const attTag = `sha256-${'c'.repeat(64)}.att`;
    const sbomTag = `sha256-${'d'.repeat(64)}.sbom`;
    const result = await executeScan(
      buildScanTargets(expectations, new Map(), []),
      client({
        listTags: async repo =>
          repo === 'rhacm2/acm-operator-bundle'
            ? ['t1', sigTag, attTag, sbomTag]
            : null,
        headManifest: async () => 'sha256:aaa',
      }),
    );
    const acm = result.repos.find(
      r => r.repo === 'rhacm2/acm-operator-bundle',
    )!;
    expect(acm.tags.map(t => t.tag)).toEqual(['t1']);
    expect(result.stats.tagsScanned).toBe(1);
    expect(result.stats.unknown).toBe(0);
  });

  it('skips probing expected repos absent from a successful walk (knownRepos)', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const probed: string[] = [];
    const result = await executeScan(
      buildScanTargets(expectations, new Map(), [
        'rhacm2/acm-operator-bundle',
      ]),
      client({
        listTags: async repo => {
          probed.push(repo);
          return repo === 'rhacm2/acm-operator-bundle' ? ['t1'] : null;
        },
        headManifest: async () => 'sha256:aaa',
      }),
      { knownRepos: new Set(['rhacm2/acm-operator-bundle']) },
    );
    // Only the repo the walk saw gets HTTP calls; the rest are absent for free.
    expect(probed).toEqual(['rhacm2/acm-operator-bundle']);
    const skipped = result.repos.find(r => r.repo === 'community/op-bundle')!;
    expect(skipped.present).toBe(false);
    expect(skipped.tags).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.stats.reposPresent).toBe(1);
    expect(result.stats.reposExpected).toBe(2);
  });

  it('records absent repos without error', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(
      buildScanTargets(expectations, new Map(), []),
      client({}),
    );
    expect(result.repos.every(r => r.present === false)).toBe(true);
    expect(result.stats.reposPresent).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('collects per-repo errors and continues', async () => {
    const expectations = deriveExpectations(catalogBundles(), '');
    const result = await executeScan(
      buildScanTargets(expectations, new Map(), []),
      client({
        listTags: async repo => {
          if (repo === 'rhacm2/acm-operator-bundle') {
            throw new RegistryRequestError('bad-response', 'tags/list returned HTTP 500');
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
        kind: 'bad-response',
        message: 'tags/list returned HTTP 500',
      },
    ]);
    expect(
      result.repos.find(r => r.repo === 'community/op-bundle'),
    ).toBeDefined();
  });
});

describe('deriveAdditionalExpectations', () => {
  const iscs = [
    {
      mirror: {
        additionalImages: [
          { name: 'registry.redhat.io/ubi8/ubi:8.10' },
          { name: 'registry.redhat.io/ubi8/ubi@sha256:pinned' },
          { name: 'quay.io/other/tool' }, // no tag → latest
          { name: 'not-a-ref' },
        ],
      },
    },
    {
      mirror: {
        additionalImages: [{ name: 'docker.io/ubi8/ubi:8.9' }],
      },
    },
  ];

  it('maps refs to prefixed repos with tag/digest/source-host detail', () => {
    const exp = deriveAdditionalExpectations(iscs, 'mirror');
    const ubi = exp.get('mirror/ubi8/ubi');
    expect(ubi?.byTag.get('8.10')).toBe('registry.redhat.io/ubi8/ubi:8.10');
    expect(ubi?.byDigest.get('sha256:pinned')).toBe(
      'registry.redhat.io/ubi8/ubi@sha256:pinned',
    );
    expect([...(ubi?.sourceHosts ?? [])].sort()).toEqual([
      'docker.io',
      'registry.redhat.io',
    ]);
    expect(exp.get('mirror/other/tool')?.byTag.get('latest')).toBe(
      'quay.io/other/tool',
    );
    expect(exp.size).toBe(2); // 'not-a-ref' skipped
  });
});

describe('deriveSupportRepos', () => {
  it('collects relatedImages repo paths and catalog index repos, prefix-joined', () => {
    const catalogs: CatalogBundles[] = [
      {
        catalog: CATALOG,
        bundles: {
          schemaVersion: 1,
          packages: {
            'op-a': {
              bundles: {
                'op-a.v1': {
                  version: '1.0.0',
                  image: 'registry.redhat.io/ops/op-a-bundle@sha256:a1',
                  relatedImages: [
                    'registry.redhat.io/ops/op-a-operand@sha256:r1',
                    'registry.redhat.io/ops/op-a-operand@sha256:r2',
                    'quay.io/other/helper:v1',
                  ],
                },
              },
              channels: {},
            },
          },
        },
      },
    ];
    const iscs = [
      {
        mirror: {
          operators: [
            { catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21' },
          ],
        },
      },
    ];
    expect(deriveSupportRepos(catalogs, iscs, 'mirror')).toEqual(
      new Set([
        'mirror/ops/op-a-operand',
        'mirror/other/helper',
        'mirror/redhat/redhat-operator-index',
      ]),
    );
  });

  it('handles empty prefix, missing operators, and unparsable refs', () => {
    expect(
      deriveSupportRepos(
        [
          {
            catalog: CATALOG,
            bundles: {
              schemaVersion: 1,
              packages: {
                p: {
                  bundles: {
                    b: { version: null, image: 'x', relatedImages: ['no-slash'] },
                  },
                  channels: {},
                },
              },
            },
          },
        ],
        [{}, { mirror: {} }],
        '',
      ),
    ).toEqual(new Set());
  });
});

describe('derivePlatformRepos', () => {
  it('returns the well-known platform repos when an ISC mirrors platform', () => {
    expect(
      derivePlatformRepos(
        [{ mirror: {} }, { mirror: { platform: { channels: [{ name: 'stable-4.21' }] } } }],
        'mirror',
      ),
    ).toEqual(
      new Set([
        'mirror/openshift-release-dev/ocp-release',
        'mirror/openshift-release-dev/ocp-v4.0-art-dev',
        'mirror/openshift/graph-image',
      ]),
    );
  });

  it('returns an empty set when no ISC has a platform section', () => {
    expect(derivePlatformRepos([{ mirror: { operators: [] } }], 'mirror')).toEqual(
      new Set(),
    );
  });
});

describe('buildScanTargets', () => {
  it('applies origin priority operator > additional > walk and merges maps', () => {
    const operator = deriveExpectations(catalogBundles(), 'mirror');
    const opRepo = [...operator.keys()][0];
    const additional = new Map([
      [
        opRepo,
        {
          repo: opRepo,
          sourceHosts: new Set(['registry.redhat.io']),
          byDigest: new Map(),
          byTag: new Map([['extra', 'registry.redhat.io/x/y:extra']]),
        },
      ],
      [
        'mirror/ubi8/ubi',
        {
          repo: 'mirror/ubi8/ubi',
          sourceHosts: new Set(['a.example', 'b.example']),
          byDigest: new Map(),
          byTag: new Map([['8.10', 'a.example/ubi8/ubi:8.10']]),
        },
      ],
    ]);
    const targets = buildScanTargets(operator, additional, [
      opRepo,
      'mirror/ubi8/ubi',
      'mirror/orphan/repo',
    ]);
    const byRepo = new Map(targets.map(t => [t.repo, t]));
    expect(byRepo.get(opRepo)?.origin).toBe('operator');
    expect(byRepo.get(opRepo)?.additionalByTag.get('extra')).toBeDefined();
    expect(byRepo.get(opRepo)?.sourceHost).toBeNull();
    expect(byRepo.get(opRepo)?.hostAmbiguous).toBe(false);
    const ubi = byRepo.get('mirror/ubi8/ubi');
    expect(ubi?.origin).toBe('additional');
    expect(ubi?.hostAmbiguous).toBe(true);
    expect(ubi?.sourceHost).toBeNull();
    expect(byRepo.get('mirror/orphan/repo')?.origin).toBe('walk');
  });

  it('classifies walked repos as support or platform; expectations outrank both', () => {
    const operator = deriveExpectations(catalogBundles(), '');
    const additional = deriveAdditionalExpectations(
      [{ mirror: { additionalImages: [{ name: 'quay.io/ops/op-a-operand:v1' }] } }],
      '',
    );
    const targets = buildScanTargets(
      operator,
      additional,
      [
        'rhacm2/acm-operator-bundle', // in operator expectations
        'ops/op-a-operand', // in additional AND support → additional wins
        'ops/other-operand', // support only
        'openshift-release-dev/ocp-release', // support outranks platform
        'openshift/graph-image', // platform only
        'plain/orphan', // nothing → walk
      ],
      new Set(['ops/op-a-operand', 'ops/other-operand', 'openshift-release-dev/ocp-release']),
      new Set([
        'openshift-release-dev/ocp-release',
        'openshift-release-dev/ocp-v4.0-art-dev',
        'openshift/graph-image',
      ]),
    );
    const originOf = (repo: string) => targets.find(t => t.repo === repo)?.origin;
    expect(originOf('rhacm2/acm-operator-bundle')).toBe('operator');
    expect(originOf('ops/op-a-operand')).toBe('additional');
    expect(originOf('ops/other-operand')).toBe('support');
    expect(originOf('openshift-release-dev/ocp-release')).toBe('support');
    expect(originOf('openshift/graph-image')).toBe('platform');
    expect(originOf('plain/orphan')).toBe('walk');
  });
});

describe('executeScan v2', () => {
  const target = (over: Partial<ScanTarget>): ScanTarget => ({
    repo: 'mirror/ubi8/ubi',
    origin: 'additional',
    sourceHost: 'registry.redhat.io',
    hostAmbiguous: false,
    bundleByDigest: new Map(),
    bundleByTag: new Map(),
    additionalByDigest: new Map(),
    additionalByTag: new Map([['8.10', 'registry.redhat.io/ubi8/ubi:8.10']]),
    ...over,
  });

  it('populates matchedAdditional and origin metadata', async () => {
    const scanClient: ScanClientLike = {
      listTags: async () => ['8.10', '8.9'],
      headManifest: async () => 'sha256:d1',
    };
    const { repos, stats } = await executeScan([target({})], scanClient);
    expect(repos[0].origin).toBe('additional');
    expect(repos[0].sourceHost).toBe('registry.redhat.io');
    expect(repos[0].tags).toEqual([
      {
        tag: '8.10',
        digest: 'sha256:d1',
        matched: null,
        matchedAdditional: 'registry.redhat.io/ubi8/ubi:8.10',
      },
      { tag: '8.9', digest: 'sha256:d1', matched: null, matchedAdditional: null },
    ]);
    expect(stats.reposAdditional).toBe(1);
    expect(stats.reposExpected).toBe(0);
    expect(stats.matched).toBe(1);
  });

  it('dedupes repeated headManifest failures into one issue per repo', async () => {
    const scanClient: ScanClientLike = {
      listTags: async () => ['a', 'b', 'c'],
      headManifest: async () => {
        throw new RegistryRequestError('bad-response', 'HEAD went wrong');
      },
    };
    const { errors } = await executeScan([target({})], scanClient);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('HEAD went wrong');
    expect(errors[0].message).toContain('3 tags affected');
  });
});

describe('buildOperatorContent', () => {
  it('groups matched tags per package and lists unknown tags', () => {
    const snapshot: RegistryScanSnapshot = {
      schemaVersion: 2,
      registryId: 'r1',
      host: 'reg.example',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-07T12:00:00.000Z',
      partial: false,
      walkOk: true,
      catalogs: [CATALOG],
      repos: [
        {
          repo: 'mirror/rhacm2/acm-operator-bundle',
          present: true,
          origin: 'operator',
          sourceHost: null,
          hostAmbiguous: false,
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
              matchedAdditional: null,
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
              matchedAdditional: null,
            },
            { tag: 'weird', digest: 'sha256:zzz', matched: null, matchedAdditional: null },
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
        reposAdditional: 0,
        reposWalked: 0,
        reposSupport: 0,
        reposPlatform: 0,
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

  it('scopes stats to operator repos — badge matches its own tables', () => {
    const snapshot: RegistryScanSnapshot = {
      schemaVersion: 2,
      registryId: 'r1',
      host: 'reg.example',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-07T12:00:00.000Z',
      partial: false,
      walkOk: true,
      catalogs: [CATALOG],
      repos: [
        {
          repo: 'mirror/rhacm2/acm-operator-bundle',
          present: true,
          origin: 'operator',
          sourceHost: null,
          hostAmbiguous: false,
          tags: [
            {
              tag: 't1',
              digest: 'sha256:aaa',
              matched: {
                package: 'advanced-cluster-management',
                bundleName: 'advanced-cluster-management.v2.16.0',
                version: '2.16.0',
                catalog: CATALOG,
              },
              matchedAdditional: null,
            },
            { tag: 'weird', digest: 'sha256:zzz', matched: null, matchedAdditional: null },
          ],
        },
        {
          repo: 'mirror/orphan',
          present: true,
          origin: 'walk',
          sourceHost: null,
          hostAmbiguous: false,
          tags: [
            { tag: 'w1', digest: null, matched: null, matchedAdditional: null },
            { tag: 'w2', digest: null, matched: null, matchedAdditional: null },
          ],
        },
      ],
      errors: [],
      // Global stats (as executeScan would produce them) count the walk
      // repo's unknown tags too — the operator-only report must not.
      stats: {
        reposExpected: 1,
        reposPresent: 1,
        tagsScanned: 4,
        matched: 1,
        unknown: 3,
        reposAdditional: 0,
        reposWalked: 1,
        reposSupport: 0,
        reposPlatform: 0,
      },
    };
    const report = buildOperatorContent(snapshot);
    expect(report.unknownTags).toHaveLength(1);
    expect(report.stats.unknown).toBe(1);
    expect(report.stats.tagsScanned).toBe(2);
    expect(report.stats.matched).toBe(1);
    // Repo-level counts still pass through from the global snapshot stats.
    expect(report.stats.reposExpected).toBe(1);
    expect(report.stats.reposPresent).toBe(1);
    expect(report.stats.reposWalked).toBe(1);
  });

  it('ignores additional/walk repos entirely', () => {
    const snapshot: RegistryScanSnapshot = {
      schemaVersion: 2,
      registryId: 'r1',
      host: 'reg.example',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-07T00:00:00.000Z',
      partial: false,
      walkOk: true,
      catalogs: [CATALOG],
      repos: [
        {
          repo: 'mirror/ubi8/ubi',
          present: true,
          origin: 'additional',
          sourceHost: 'registry.redhat.io',
          hostAmbiguous: false,
          tags: [
            { tag: '8.9', digest: 'sha256:x', matched: null, matchedAdditional: null },
          ],
        },
        {
          repo: 'mirror/orphan',
          present: true,
          origin: 'walk',
          sourceHost: null,
          hostAmbiguous: false,
          tags: [
            { tag: 'v1', digest: null, matched: null, matchedAdditional: null },
          ],
        },
      ],
      errors: [],
      stats: {
        reposExpected: 0,
        reposPresent: 0,
        tagsScanned: 2,
        matched: 0,
        unknown: 2,
        reposAdditional: 1,
        reposWalked: 1,
        reposSupport: 0,
        reposPlatform: 0,
      },
    };
    const report = buildOperatorContent(snapshot);
    expect(report.packages).toEqual({});
    expect(report.unknownTags).toEqual([]);
  });
});

describe('buildOperatorContent additional images', () => {
  it('lists non-operator tags with source refs, passes walkOk through', () => {
    const snapshot: RegistryScanSnapshot = {
      schemaVersion: 2,
      registryId: 'r1',
      host: 'quay.local:8443',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-08T00:00:00.000Z',
      partial: false,
      walkOk: false,
      catalogs: ['redhat-operator-index:v4.21'],
      repos: [
        {
          repo: 'mirror/extra/tools',
          present: true,
          origin: 'additional',
          sourceHost: 'docker.io',
          hostAmbiguous: false,
          tags: [
            {
              tag: 'v1',
              digest: 'sha256:aaa',
              matched: null,
              matchedAdditional: 'docker.io/extra/tools:v1',
            },
          ],
        },
        {
          repo: 'mirror/orphan/thing',
          present: true,
          origin: 'walk',
          sourceHost: null,
          hostAmbiguous: false,
          tags: [
            { tag: 'old', digest: 'sha256:bbb', matched: null, matchedAdditional: null },
          ],
        },
      ],
      errors: [],
      stats: {
        reposExpected: 0,
        reposPresent: 0,
        tagsScanned: 2,
        matched: 0,
        unknown: 2,
        reposAdditional: 1,
        reposWalked: 1,
        reposSupport: 0,
        reposPlatform: 0,
      },
    };
    const report = buildOperatorContent(snapshot);
    expect(report.walkOk).toBe(false);
    expect(report.additionalImages).toEqual([
      {
        repo: 'mirror/extra/tools',
        tag: 'v1',
        digest: 'sha256:aaa',
        source: 'docker.io/extra/tools:v1',
      },
      {
        repo: 'mirror/orphan/thing',
        tag: 'old',
        digest: 'sha256:bbb',
        source: null,
      },
    ]);
    // operator tables untouched by non-operator repos
    expect(report.packages).toEqual({});
    expect(report.unknownTags).toEqual([]);
  });
});
