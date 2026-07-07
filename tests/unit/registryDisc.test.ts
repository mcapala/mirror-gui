import { describe, it, expect } from 'vitest';
import YAML from 'yaml';
import {
  DEFAULT_ORPHAN_HOST,
  generateDisc,
  repoSuffix,
  resolveChannelHead,
  type DiscInputs,
  type DiscOptions,
} from '../../server/registry/disc.js';
import type { IscConfig } from '../../server/acm/reconcile.js';
import type { DeployedOperatorSnapshot } from '../../server/acm/types.js';
import type {
  CatalogBundles,
  RegistryScanSnapshot,
  ScannedRepo,
} from '../../server/registry/types.js';

const KEY = 'redhat-operator-index:v4.21';
const REF = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';

// op-a stable channel graph: v3.0.0 replaces v2.0.0 replaces v1.0.0.
function catalogs(): CatalogBundles[] {
  return [
    {
      catalog: KEY,
      bundles: {
        schemaVersion: 1,
        packages: {
          'op-a': {
            bundles: {
              'op-a.v1.0.0': {
                version: '1.0.0',
                image: 'registry.redhat.io/ops/op-a-bundle@sha256:a1',
                relatedImages: ['registry.redhat.io/ops/op-a-operand@sha256:r1'],
              },
              'op-a.v2.0.0': {
                version: '2.0.0',
                image: 'registry.redhat.io/ops/op-a-bundle@sha256:a2',
                relatedImages: ['registry.redhat.io/ops/op-a-operand@sha256:r2'],
              },
              'op-a.v3.0.0': {
                version: '3.0.0',
                image: 'registry.redhat.io/ops/op-a-bundle@sha256:a3',
                relatedImages: ['registry.redhat.io/ops/op-a-operand@sha256:r3'],
              },
            },
            channels: {
              stable: [
                { name: 'op-a.v1.0.0' },
                { name: 'op-a.v2.0.0', replaces: 'op-a.v1.0.0' },
                { name: 'op-a.v3.0.0', replaces: 'op-a.v2.0.0' },
              ],
            },
          },
        },
      },
    },
  ];
}

function operatorRepo(over: Partial<ScannedRepo> = {}): ScannedRepo {
  return {
    repo: 'mirror/ops/op-a-bundle',
    present: true,
    origin: 'operator',
    sourceHost: null,
    hostAmbiguous: false,
    tags: [
      {
        tag: 'v1.0.0',
        digest: 'sha256:a1',
        matched: { package: 'op-a', bundleName: 'op-a.v1.0.0', version: '1.0.0', catalog: KEY },
        matchedAdditional: null,
      },
      {
        tag: 'v2.0.0',
        digest: 'sha256:a2',
        matched: { package: 'op-a', bundleName: 'op-a.v2.0.0', version: '2.0.0', catalog: KEY },
        matchedAdditional: null,
      },
      {
        tag: 'v3.0.0',
        digest: 'sha256:a3',
        matched: { package: 'op-a', bundleName: 'op-a.v3.0.0', version: '3.0.0', catalog: KEY },
        matchedAdditional: null,
      },
    ],
    ...over,
  };
}

function snapshot(over: Partial<RegistryScanSnapshot> = {}): RegistryScanSnapshot {
  return {
    schemaVersion: 2,
    registryId: 'r1',
    host: 'quay.example',
    pathPrefix: 'mirror',
    scannedAt: '2026-07-07T10:00:00.000Z',
    partial: false,
    walkOk: true,
    catalogs: [KEY],
    repos: [operatorRepo()],
    errors: [],
    stats: {
      reposExpected: 1,
      reposPresent: 1,
      tagsScanned: 3,
      matched: 3,
      unknown: 0,
      reposAdditional: 0,
      reposWalked: 0,
    },
    ...over,
  };
}

function acmOk(over: Partial<DeployedOperatorSnapshot> = {}): DeployedOperatorSnapshot {
  return {
    schemaVersion: 2,
    refreshedAt: '2026-07-07T09:00:00.000Z',
    hubs: [
      {
        id: 'h1',
        name: 'hub1',
        status: 'ok',
        error: null,
        truncated: false,
        skippedItems: 0,
        clusterCount: 2,
      },
    ],
    clusters: [],
    packages: {},
    ...over,
  };
}

function isc(over: Partial<IscConfig['mirror']> = {}): IscConfig {
  return {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: {
      operators: [
        {
          catalog: REF,
          packages: [
            { name: 'op-a', channels: [{ name: 'stable', minVersion: '2.0.0' }] },
          ],
        },
      ],
      ...over,
    },
  };
}

const OPTS: DiscOptions = {
  strict: false,
  includeAdditionalImages: true,
  includeOrphans: [],
};

function inputs(over: Partial<DiscInputs> = {}): DiscInputs {
  return {
    snapshot: snapshot(),
    catalogs: catalogs(),
    acm: acmOk(),
    iscs: [isc()],
    ...over,
  };
}

describe('resolveChannelHead', () => {
  it('picks the entry nothing replaces or skips', () => {
    const cat = catalogs()[0].bundles.packages['op-a'];
    expect(resolveChannelHead(cat.channels.stable, cat.bundles)).toBe(
      'op-a.v3.0.0',
    );
  });

  it('returns null on a cycle', () => {
    expect(
      resolveChannelHead(
        [
          { name: 'a', replaces: 'b' },
          { name: 'b', replaces: 'a' },
        ],
        {},
      ),
    ).toBeNull();
  });
});

describe('repoSuffix', () => {
  it('strips the prefix; empty prefix is identity', () => {
    expect(repoSuffix('mirror/ubi8/ubi', 'mirror')).toBe('ubi8/ubi');
    expect(repoSuffix('ubi8/ubi', '')).toBe('ubi8/ubi');
  });
});

describe('generateDisc — keep set', () => {
  it('keeps [min…head] and proposes below-min versions', () => {
    const { report, discYaml } = generateDisc(inputs(), OPTS);
    expect(report.operators.candidates.map(c => c.version)).toEqual(['1.0.0']);
    const doc = YAML.parse(discYaml);
    expect(doc.apiVersion).toBe('mirror.openshift.io/v2alpha1');
    expect(doc.kind).toBe('DeleteImageSetConfiguration');
    expect(doc.delete.operators).toEqual([
      {
        catalog: REF,
        packages: [
          {
            name: 'op-a',
            channels: [{ name: 'stable', minVersion: '1.0.0', maxVersion: '1.0.0' }],
          },
        ],
      },
    ]);
    expect(discYaml).not.toContain('operator-index@');
  });

  it('honors maxVersion — versions above it become candidates', () => {
    const config = isc();
    config.mirror!.operators![0].packages![0].channels = [
      { name: 'stable', minVersion: '1.0.0', maxVersion: '2.0.0' },
    ];
    const { report } = generateDisc(inputs({ iscs: [config] }), OPTS);
    expect(report.operators.candidates.map(c => c.version)).toEqual(['3.0.0']);
  });

  it('keeps only the head when minVersion is absent', () => {
    const config = isc();
    config.mirror!.operators![0].packages![0].channels = [{ name: 'stable' }];
    const { report } = generateDisc(inputs({ iscs: [config] }), OPTS);
    expect(report.operators.candidates.map(c => c.version).sort()).toEqual([
      '1.0.0',
      '2.0.0',
    ]);
  });

  it('full: true keeps the whole catalog', () => {
    const config = isc();
    config.mirror!.operators![0] = { catalog: REF, full: true };
    const { report } = generateDisc(inputs({ iscs: [config] }), OPTS);
    expect(report.operators.candidates).toEqual([]);
  });

  it('a package without channels is fully kept and reported', () => {
    const config = isc();
    config.mirror!.operators![0].packages = [{ name: 'op-a' }];
    const { report } = generateDisc(inputs({ iscs: [config] }), OPTS);
    expect(report.operators.candidates).toEqual([]);
    expect(report.operators.channelUnpinned).toEqual([
      { catalog: KEY, package: 'op-a' },
    ]);
  });

  it('an unknown ISC channel is reported and keeps the whole package (shrink-only invariant)', () => {
    const config = isc();
    config.mirror!.operators![0].packages![0].channels = [
      { name: 'nope', minVersion: '1.0.0' },
    ];
    const { report } = generateDisc(inputs({ iscs: [config] }), OPTS);
    expect(report.operators.unknownChannels).toEqual([
      { catalog: KEY, package: 'op-a', channel: 'nope' },
    ]);
    // A data gap (unknown channel) may only shrink the DISC (spec §8) — the
    // whole package is kept, never emptied into delete candidates.
    expect(report.operators.candidates).toEqual([]);
    expect(
      report.warnings.some(
        w => w.includes('channel "nope"') && w.includes('op-a'),
      ),
    ).toBe(true);
  });

  it('unions keep sets across ISCs', () => {
    const second = isc();
    second.mirror!.operators![0].packages![0].channels = [
      { name: 'stable', minVersion: '1.0.0' },
    ];
    const { report } = generateDisc(inputs({ iscs: [isc(), second] }), OPTS);
    expect(report.operators.candidates).toEqual([]);
  });

  it('an unparsable bundle version is kept (never a candidate)', () => {
    const cats = catalogs();
    cats[0].bundles.packages['op-a'].bundles['op-a.v1.0.0'].version = null;
    const snap = snapshot();
    snap.repos[0].tags[0].matched!.version = null;
    const { report } = generateDisc(
      inputs({ catalogs: cats, snapshot: snap }),
      OPTS,
    );
    expect(report.operators.candidates).toEqual([]);
  });

  it('suppresses a catalog whose bundles.json is unavailable', () => {
    const { report } = generateDisc(inputs({ catalogs: [] }), OPTS);
    expect(report.operators.candidates).toEqual([]);
    expect(report.warnings.some(w => w.includes('bundles.json unavailable'))).toBe(
      true,
    );
  });
});

describe('generateDisc — gates', () => {
  it('holds a still-deployed candidate with the cluster list', () => {
    const acm = acmOk({
      packages: {
        'op-a': {
          deployments: [
            { cluster: 'c1', hub: 'hub1', version: '1.0.0', behind: true },
          ],
          minDeployed: '1.0.0',
          maxDeployed: '1.0.0',
          latestAvailable: null,
          catalogSource: null,
          status: 'behind',
        },
      },
    });
    const { report, discYaml } = generateDisc(inputs({ acm }), OPTS);
    expect(report.operators.candidates).toEqual([]);
    expect(report.operators.held).toHaveLength(1);
    expect(report.operators.held[0]).toMatchObject({
      reason: 'still-deployed',
      version: '1.0.0',
    });
    expect(report.operators.held[0].detail).toContain('c1 @ hub1');
    expect(YAML.parse(discYaml).delete.operators).toBeUndefined();
  });

  it.each([
    ['missing snapshot', null],
    [
      'errored hub',
      acmOk({
        hubs: [
          {
            id: 'h1',
            name: 'hub1',
            status: 'error',
            error: 'boom',
            truncated: false,
            skippedItems: 0,
            clusterCount: 0,
          },
        ],
      }),
    ],
    [
      'truncated hub',
      acmOk({ hubs: [{ ...acmOk().hubs[0], truncated: true }] }),
    ],
    ['empty hub list', acmOk({ hubs: [] })],
  ] as Array<[string, DeployedOperatorSnapshot | null]>)(
    'holds ALL operator candidates when the ACM snapshot is unusable (%s)',
    (_label, acm) => {
      const { report, strictViolation } = generateDisc(
        inputs({ acm }),
        { ...OPTS, strict: true },
      );
      expect(report.operators.candidates).toEqual([]);
      expect(report.operators.held).toHaveLength(1);
      expect(report.operators.held[0].reason).toBe('acm-unverifiable');
      expect(report.warnings.some(w => w.includes('held back'))).toBe(true);
      expect(strictViolation).toBe(true);
    },
  );

  it('holds a candidate whose related image is shared with a kept bundle', () => {
    const cats = catalogs();
    // v1's operand digest r2 is also v2's (kept) operand.
    cats[0].bundles.packages['op-a'].bundles['op-a.v1.0.0'].relatedImages = [
      'registry.redhat.io/ops/op-a-operand@sha256:r2',
    ];
    const { report } = generateDisc(inputs({ catalogs: cats }), OPTS);
    expect(report.operators.held).toHaveLength(1);
    expect(report.operators.held[0].reason).toBe('shared-image');
    expect(report.operators.held[0].detail).toContain('op-a op-a.v2.0.0');
  });

  it('a kept additionalImage protects an operator candidate (path:tag)', () => {
    const cats = catalogs();
    cats[0].bundles.packages['op-a'].bundles['op-a.v1.0.0'].relatedImages = [
      'registry.redhat.io/ubi8/ubi:8.10',
    ];
    const withAi = isc({
      additionalImages: [{ name: 'quay.io/ubi8/ubi:8.10' }],
    });
    const { report } = generateDisc(inputs({ catalogs: cats, iscs: [withAi] }), OPTS);
    expect(report.operators.held[0]?.reason).toBe('shared-image');
  });

  it('strict mode flags only fleet-gate holds, not shared-image holds', () => {
    const cats = catalogs();
    cats[0].bundles.packages['op-a'].bundles['op-a.v1.0.0'].relatedImages = [
      'registry.redhat.io/ops/op-a-operand@sha256:r2',
    ];
    const { strictViolation } = generateDisc(inputs({ catalogs: cats }), {
      ...OPTS,
      strict: true,
    });
    expect(strictViolation).toBe(false);
  });
});

function additionalRepo(over: Partial<ScannedRepo> = {}): ScannedRepo {
  return {
    repo: 'mirror/ubi8/ubi',
    present: true,
    origin: 'additional',
    sourceHost: 'registry.redhat.io',
    hostAmbiguous: false,
    tags: [
      {
        tag: '8.10',
        digest: 'sha256:u10',
        matched: null,
        matchedAdditional: 'registry.redhat.io/ubi8/ubi:8.10',
      },
      { tag: '8.9', digest: 'sha256:u9', matched: null, matchedAdditional: null },
    ],
    ...over,
  };
}

describe('generateDisc — additionalImages', () => {
  const aiIsc = (): IscConfig =>
    isc({ additionalImages: [{ name: 'registry.redhat.io/ubi8/ubi:8.10' }] });

  it('Class 1: stale tag becomes a candidate with a reconstructed ref', () => {
    const snap = snapshot({ repos: [operatorRepo(), additionalRepo()] });
    const { report, discYaml } = generateDisc(
      inputs({ snapshot: snap, iscs: [aiIsc()] }),
      OPTS,
    );
    expect(report.additionalImages.class1).toEqual([
      {
        repo: 'mirror/ubi8/ubi',
        tag: '8.9',
        digest: 'sha256:u9',
        sourceRef: 'registry.redhat.io/ubi8/ubi:8.9',
      },
    ]);
    expect(YAML.parse(discYaml).delete.additionalImages).toEqual([
      { name: 'registry.redhat.io/ubi8/ubi:8.9' },
    ]);
  });

  it('a host-ambiguous repo downgrades to orphans', () => {
    const snap = snapshot({
      repos: [
        additionalRepo({ hostAmbiguous: true, sourceHost: null }),
      ],
    });
    const { report } = generateDisc(
      inputs({ snapshot: snap, iscs: [aiIsc()] }),
      OPTS,
    );
    expect(report.additionalImages.class1).toEqual([]);
    expect(report.additionalImages.orphans).toEqual([
      {
        repo: 'mirror/ubi8/ubi',
        tag: '8.9',
        digest: 'sha256:u9',
        suggestedRef: `${DEFAULT_ORPHAN_HOST}/ubi8/ubi:8.9`,
        hostAmbiguous: true,
      },
    ]);
  });

  it('walk repos are orphans, never auto-included', () => {
    const walkRepo: ScannedRepo = {
      repo: 'mirror/legacy/tool',
      present: true,
      origin: 'walk',
      sourceHost: null,
      hostAmbiguous: false,
      tags: [
        { tag: 'v1', digest: 'sha256:w1', matched: null, matchedAdditional: null },
      ],
    };
    const snap = snapshot({ repos: [operatorRepo(), walkRepo] });
    const { report, discYaml } = generateDisc(inputs({ snapshot: snap }), OPTS);
    expect(report.additionalImages.orphans).toEqual([
      {
        repo: 'mirror/legacy/tool',
        tag: 'v1',
        digest: 'sha256:w1',
        suggestedRef: `${DEFAULT_ORPHAN_HOST}/legacy/tool:v1`,
        hostAmbiguous: false,
      },
    ]);
    expect(YAML.parse(discYaml).delete.additionalImages).toBeUndefined();
  });

  it('a valid orphan pick lands in the DISC; invalid picks are rejected per item', () => {
    const walkRepo: ScannedRepo = {
      repo: 'mirror/legacy/tool',
      present: true,
      origin: 'walk',
      sourceHost: null,
      hostAmbiguous: false,
      tags: [
        { tag: 'v1', digest: 'sha256:w1', matched: null, matchedAdditional: null },
      ],
    };
    const snap = snapshot({ repos: [operatorRepo(), walkRepo] });
    const { report, discYaml } = generateDisc(inputs({ snapshot: snap }), {
      ...OPTS,
      includeOrphans: [
        { repo: 'mirror/legacy/tool', tag: 'v1', sourceRef: 'quay.io/legacy/tool:v1' },
        { repo: 'mirror/legacy/tool', tag: 'nope', sourceRef: 'quay.io/legacy/tool:nope' },
        { repo: 'mirror/absent', tag: 'v1', sourceRef: 'quay.io/absent:v1' },
        { repo: 'mirror/legacy/tool', tag: 'v1', sourceRef: 'quay.io/wrong/path:v1' },
        { repo: 'mirror/ops/op-a-bundle', tag: 'v1.0.0', sourceRef: 'quay.io/ops/op-a-bundle:v1.0.0' },
      ],
    });
    expect(YAML.parse(discYaml).delete.additionalImages).toEqual([
      { name: 'quay.io/legacy/tool:v1' },
    ]);
    expect(report.additionalImages.rejectedPicks).toHaveLength(4);
    expect(
      report.additionalImages.rejectedPicks.map(p => p.reason).join(' | '),
    ).toMatch(/not in the scan snapshot.*|not an orphan repo|path does not match/);
  });

  it('walkOk=false suppresses orphans, rejects walk picks, and warns', () => {
    const walkRepo: ScannedRepo = {
      repo: 'mirror/legacy/tool',
      present: true,
      origin: 'walk',
      sourceHost: null,
      hostAmbiguous: false,
      tags: [
        { tag: 'v1', digest: null, matched: null, matchedAdditional: null },
      ],
    };
    const snap = snapshot({ walkOk: false, repos: [walkRepo] });
    const { report } = generateDisc(inputs({ snapshot: snap }), {
      ...OPTS,
      includeOrphans: [
        { repo: 'mirror/legacy/tool', tag: 'v1', sourceRef: 'quay.io/legacy/tool:v1' },
      ],
    });
    expect(report.additionalImages.orphans).toEqual([]);
    expect(report.additionalImages.rejectedPicks[0].reason).toContain(
      'orphan discovery incomplete',
    );
    expect(report.warnings.some(w => w.includes('Orphan discovery incomplete'))).toBe(true);
  });

  it('includeAdditionalImages=false omits the section but keeps the analysis', () => {
    const snap = snapshot({ repos: [operatorRepo(), additionalRepo()] });
    const { report, discYaml } = generateDisc(
      inputs({ snapshot: snap, iscs: [aiIsc()] }),
      { ...OPTS, includeAdditionalImages: false },
    );
    expect(YAML.parse(discYaml).delete.additionalImages).toBeUndefined();
    expect(report.additionalImages.class1).toHaveLength(1);
    expect(report.stats.discAdditionalImages).toBe(0);
  });
});

describe('generateDisc — report hygiene', () => {
  it('surfaces errored repos as unverifiable, never as absent', () => {
    const snap = snapshot({
      partial: true,
      repos: [],
      errors: [
        {
          repo: 'mirror/ops/op-a-bundle',
          catalog: null,
          kind: 'unreachable',
          message: 'listTags blew up',
        },
      ],
    });
    const { report } = generateDisc(inputs({ snapshot: snap }), OPTS);
    expect(report.operators.unverifiableRepos).toEqual([
      {
        repo: 'mirror/ops/op-a-bundle',
        message: 'listTags blew up — no candidates proposed for this repo',
      },
    ]);
    expect(report.operators.candidates).toEqual([]);
  });

  it('a matched bundle in no channel goes to manualBundles', () => {
    const cats = catalogs();
    cats[0].bundles.packages['op-a'].channels.stable =
      cats[0].bundles.packages['op-a'].channels.stable.filter(
        e => e.name !== 'op-a.v1.0.0',
      );
    const { report } = generateDisc(inputs({ catalogs: cats }), OPTS);
    expect(report.operators.candidates).toEqual([]);
    expect(report.operators.manualBundles).toHaveLength(1);
    expect(report.operators.manualBundles[0].bundleName).toBe('op-a.v1.0.0');
  });

  it('dedups multi-tag occurrences of one version in the DISC', () => {
    const snap = snapshot();
    snap.repos[0].tags.push({
      tag: 'v1.0.0-copy',
      digest: 'sha256:a1',
      matched: { package: 'op-a', bundleName: 'op-a.v1.0.0', version: '1.0.0', catalog: KEY },
      matchedAdditional: null,
    });
    const { discYaml, report } = generateDisc(inputs({ snapshot: snap }), OPTS);
    const doc = YAML.parse(discYaml);
    expect(doc.delete.operators[0].packages[0].channels).toHaveLength(1);
    expect(report.stats.discOperatorEntries).toBe(1);
  });
});

describe('generateDisc — catalog index protection', () => {
  // oc-mirror mirrors the catalog index itself; the registry walk discovers
  // it as a walk-origin repo. The DISC must never contain (or offer to
  // delete) the mirrored catalog index (spec §7.2/§9).
  const indexRepo = (): ScannedRepo => ({
    repo: 'mirror/redhat/redhat-operator-index',
    present: true,
    origin: 'walk',
    sourceHost: null,
    hostAmbiguous: false,
    tags: [
      { tag: 'v4.21', digest: 'sha256:idx', matched: null, matchedAdditional: null },
    ],
  });

  it('a walk-origin repo holding the mirrored index tag never appears as an orphan', () => {
    const snap = snapshot({ repos: [operatorRepo(), indexRepo()] });
    const { report } = generateDisc(inputs({ snapshot: snap }), OPTS);
    expect(
      report.additionalImages.orphans.some(o => o.repo === indexRepo().repo),
    ).toBe(false);
  });

  it('an explicit orphan pick targeting the index repo:tag is rejected, never in the DISC', () => {
    const snap = snapshot({ repos: [operatorRepo(), indexRepo()] });
    const { report, discYaml } = generateDisc(inputs({ snapshot: snap }), {
      ...OPTS,
      includeOrphans: [
        { repo: indexRepo().repo, tag: 'v4.21', sourceRef: REF },
      ],
    });
    expect(report.additionalImages.rejectedPicks).toHaveLength(1);
    expect(report.additionalImages.rejectedPicks[0]).toMatchObject({
      repo: indexRepo().repo,
      tag: 'v4.21',
    });
    expect(report.additionalImages.rejectedPicks[0].reason).toMatch(/catalog/);
    expect(YAML.parse(discYaml).delete.additionalImages).toBeUndefined();
  });

  it('Class 1: a stale additional tag sharing only a DIGEST with a kept image is held', () => {
    // op-a.v3.0.0's related image is kept (sha256:r3); an unrelated
    // additional repo's stale tag happens to share that digest even though
    // its host/path:tag does not match any kept ref.
    const repo = additionalRepo({
      tags: [
        { tag: '8.9', digest: 'sha256:r3', matched: null, matchedAdditional: null },
      ],
    });
    const snap = snapshot({ repos: [operatorRepo(), repo] });
    const { report } = generateDisc(inputs({ snapshot: snap }), OPTS);
    expect(report.additionalImages.class1).toEqual([]);
    expect(report.additionalImages.held).toHaveLength(1);
    expect(report.additionalImages.held[0]).toMatchObject({
      reason: 'shared-image',
      repo: 'mirror/ubi8/ubi',
      tag: '8.9',
    });
    expect(report.additionalImages.held[0].detail).toContain('sha256:r3');
  });

  it('orphan pick: a walk tag sharing only a DIGEST with a kept image is rejected', () => {
    const walkRepo: ScannedRepo = {
      repo: 'mirror/legacy/tool',
      present: true,
      origin: 'walk',
      sourceHost: null,
      hostAmbiguous: false,
      tags: [
        { tag: 'v1', digest: 'sha256:r3', matched: null, matchedAdditional: null },
      ],
    };
    const snap = snapshot({ repos: [operatorRepo(), walkRepo] });
    const { report } = generateDisc(inputs({ snapshot: snap }), {
      ...OPTS,
      includeOrphans: [
        { repo: 'mirror/legacy/tool', tag: 'v1', sourceRef: 'quay.io/legacy/tool:v1' },
      ],
    });
    expect(report.additionalImages.rejectedPicks).toHaveLength(1);
    expect(report.additionalImages.rejectedPicks[0].reason).toContain('sha256:r3');
  });
});
