import { describe, it, expect } from 'vitest';
import {
  buildCatalogUrlMap,
  buildReconcileCatalog,
  catalogKeyFromUrl,
  reconcile,
  type IscConfig,
} from '../../server/acm/reconcile.js';
import type {
  ClusterInfo,
  DeployedOperatorSnapshot,
  HubSnapshotStatus,
  PackageDeployment,
} from '../../server/acm/types.js';
import { buildAliasLookup, buildCatalogLookup, buildSnapshot, type HubFetchOutcome } from '../../server/acm/aggregate.js';

const OK_HUB: HubSnapshotStatus = {
  id: 'h1', name: 'hub-1', status: 'ok', error: null,
  truncated: false, skippedItems: 0, clusterCount: 2,
};

function snap(opts: {
  hubs?: HubSnapshotStatus[];
  clusters?: ClusterInfo[];
  packages?: Record<string, { deployments: PackageDeployment[] }>;
}): DeployedOperatorSnapshot {
  const packages: DeployedOperatorSnapshot['packages'] = {};
  for (const [name, p] of Object.entries(opts.packages ?? {})) {
    const versions = p.deployments.map(d => d.version).sort();
    packages[name] = {
      deployments: p.deployments,
      minDeployed: versions[0],
      maxDeployed: versions[versions.length - 1],
      latestAvailable: null,
      catalogSource: null,
      status: 'unknown',
    };
  }
  return {
    schemaVersion: 2,
    refreshedAt: '2026-07-06T00:00:00Z',
    hubs: opts.hubs ?? [OK_HUB],
    clusters: opts.clusters ?? [],
    packages,
  };
}

function dep(cluster: string, version: string): PackageDeployment {
  return { cluster, hub: 'hub-1', version, behind: false };
}

const CATALOG = buildReconcileCatalog({
  operators: {
    'redhat-operator-index:v4.21': [
      {
        name: 'odf-operator',
        defaultChannel: 'stable-4.16',
        channelVersions: {
          'stable-4.15': ['4.15.0', '4.15.2'],
          'stable-4.16': ['4.16.0', '4.16.1'],
        },
      },
    ],
  },
});

const CATALOG_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';

function iscWith(channels: { name: string; minVersion?: string }[]): IscConfig {
  return {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: {
      operators: [
        { catalog: CATALOG_URL, packages: [{ name: 'odf-operator', channels }] },
      ],
    },
  };
}

describe('catalogKeyFromUrl', () => {
  it('extracts name:tag from a catalog URL', () => {
    expect(catalogKeyFromUrl(CATALOG_URL)).toBe('redhat-operator-index:v4.21');
  });
  it('rejects digest-pinned and tagless references', () => {
    expect(
      catalogKeyFromUrl('registry.redhat.io/redhat/redhat-operator-index@sha256:abc'),
    ).toBeNull();
    expect(catalogKeyFromUrl('registry.redhat.io/redhat/no-tag')).toBeNull();
  });
});

describe('operator minVersion floors', () => {
  it('proposes raising minVersion to the lowest attributed deployed version', () => {
    const s = snap({
      packages: {
        'odf-operator': {
          deployments: [dep('c1', '4.16.0'), dep('c2', '4.16.1')],
        },
      },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.16' }]), s, CATALOG);
    const raise = result.suggestions.find(x => x.kind === 'raise-min-version');
    expect(raise).toMatchObject({
      current: null,
      proposed: '4.16.0',
      defaultChecked: true,
      path: {
        type: 'operator-channel',
        catalog: CATALOG_URL,
        package: 'odf-operator',
        channel: 'stable-4.16',
      },
    });
    expect(raise!.evidence).toContain('c1');
  });

  it('never raises minVersion above a still-deployed version', () => {
    const s = snap({
      packages: {
        'odf-operator': {
          deployments: [dep('c1', '4.16.0'), dep('c2', '4.16.1')],
        },
      },
    });
    const result = reconcile(
      iscWith([{ name: 'stable-4.16', minVersion: '4.16.0' }]),
      s,
      CATALOG,
    );
    // floor equals current → no suggestion at all
    expect(result.suggestions).toHaveLength(0);
  });

  it('flags drift when a cluster is below the current minVersion', () => {
    const s = snap({
      packages: {
        'odf-operator': { deployments: [dep('c1', '4.16.0')] },
      },
    });
    const result = reconcile(
      iscWith([{ name: 'stable-4.16', minVersion: '4.16.1' }]),
      s,
      CATALOG,
    );
    const drift = result.suggestions.find(
      x => x.kind === 'lower-min-version-drift',
    );
    expect(drift).toMatchObject({
      current: '4.16.1',
      proposed: '4.16.0',
      defaultChecked: true,
    });
    expect(drift!.evidence).toMatch(/DRIFT/);
  });

  it('applies the floor to every ISC channel containing the version', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.16',
            channelVersions: {
              'stable-4.15': ['4.15.0', '4.15.2', '4.16.0'],
              'stable-4.16': ['4.16.0', '4.16.1'],
            },
          },
        ],
      },
    });
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(
      iscWith([{ name: 'stable-4.15' }, { name: 'stable-4.16' }]),
      s,
      multi,
    );
    const raises = result.suggestions.filter(x => x.kind === 'raise-min-version');
    expect(raises.map(r => (r.path as { channel: string }).channel).sort()).toEqual([
      'stable-4.15',
      'stable-4.16',
    ]);
    expect(raises.every(r => r.proposed === '4.16.0')).toBe(true);
  });

  it('falls back to numeric comparison when a deployed version attributes to no channel', () => {
    const s = snap({
      packages: {
        'odf-operator': {
          deployments: [dep('c1', '4.15.1'), dep('c2', '4.16.1')], // 4.15.1 in no channel
        },
      },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.16' }]), s, CATALOG);
    const raise = result.suggestions.find(x => x.kind === 'raise-min-version');
    expect(raise?.proposed).toBe('4.15.1'); // pkg-wide numeric floor
    expect(result.warnings.some(w => w.includes('4.15.1'))).toBe(true);
  });

  it('reports ISC packages missing from the catalog as noData and warns on unknown catalogs', () => {
    const s = snap({
      packages: { 'other-op': { deployments: [dep('c1', '1.0.0')] } },
    });
    const config: IscConfig = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: {
        operators: [
          {
            catalog: CATALOG_URL,
            packages: [{ name: 'other-op', channels: [{ name: 'stable' }] }],
          },
          {
            catalog: 'quay.io/custom/index:v1',
            packages: [{ name: 'thing', channels: [{ name: 'alpha' }] }],
          },
        ],
      },
    };
    const result = reconcile(config, s, CATALOG);
    expect(result.noData).toContainEqual({
      package: 'other-op',
      reason: 'not-in-catalog',
    });
    expect(result.noData).toContainEqual({
      package: 'thing',
      reason: 'catalog-unavailable',
    });
    expect(result.warnings.some(w => w.includes('quay.io/custom/index:v1'))).toBe(true);
  });

  it('includes a clusters-behind report for behind packages in the ISC', () => {
    const s = snap({
      packages: {
        'odf-operator': {
          deployments: [dep('c1', '4.16.0'), dep('c2', '4.16.1')],
        },
      },
    });
    s.packages['odf-operator'].status = 'behind';
    s.packages['odf-operator'].latestAvailable = '4.16.1';
    s.packages['odf-operator'].deployments[0].behind = true;
    const result = reconcile(iscWith([{ name: 'stable-4.16' }]), s, CATALOG);
    expect(result.report).toEqual([
      {
        package: 'odf-operator',
        latestAvailable: '4.16.1',
        behindClusters: [{ cluster: 'c1', hub: 'hub-1', version: '4.16.0' }],
      },
    ]);
  });
});

describe('removals, resets, add-channel', () => {
  it('suggests removing an operator channel with no attributable deployments', () => {
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(
      iscWith([{ name: 'stable-4.15' }, { name: 'stable-4.16' }]),
      s,
      CATALOG,
    );
    const removal = result.suggestions.find(x => x.kind === 'remove-channel');
    expect(removal).toMatchObject({
      path: { type: 'operator-channel', channel: 'stable-4.15' },
      defaultChecked: false,
    });
  });

  it('suppresses removals and resets when any hub errored or truncated', () => {
    const badHub: HubSnapshotStatus = { ...OK_HUB, id: 'h2', name: 'hub-2', status: 'error', error: 'down' };
    const s = snap({
      hubs: [OK_HUB, badHub],
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(
      iscWith([{ name: 'stable-4.15' }, { name: 'stable-4.16' }]),
      s,
      CATALOG,
    );
    expect(result.suggestions.some(x => x.kind === 'remove-channel')).toBe(false);
    expect(result.suggestions.some(x => x.kind === 'reset-unused-operator')).toBe(false);
    expect(result.warnings.some(w => w.includes('hub-2'))).toBe(true);
    // floors still fire
    expect(result.suggestions.some(x => x.kind === 'raise-min-version')).toBe(true);
  });

  it('proposes resetting an undeployed operator to defaultChannel @ channel head', () => {
    const s = snap({ packages: {} });
    const result = reconcile(
      iscWith([{ name: 'stable-4.15', minVersion: '4.15.0' }]),
      s,
      CATALOG,
    );
    const reset = result.suggestions.find(x => x.kind === 'reset-unused-operator');
    expect(reset).toMatchObject({
      path: { type: 'operator', catalog: CATALOG_URL, package: 'odf-operator' },
      proposedChannels: [{ name: 'stable-4.16', minVersion: '4.16.1' }],
      defaultChecked: false,
    });
    expect(result.noData).toContainEqual({
      package: 'odf-operator',
      reason: 'no-fleet-data',
    });
  });

  it('does not propose a reset when the entry already is defaultChannel @ head', () => {
    const s = snap({ packages: {} });
    const result = reconcile(
      iscWith([{ name: 'stable-4.16', minVersion: '4.16.1' }]),
      s,
      CATALOG,
    );
    expect(result.suggestions.some(x => x.kind === 'reset-unused-operator')).toBe(false);
  });

  it('offers newer catalog channels as unchecked add-channel suggestions', () => {
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.15.2')] } },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.15' }]), s, CATALOG);
    const add = result.suggestions.find(x => x.kind === 'add-channel');
    expect(add).toMatchObject({
      path: { type: 'operator-channel', channel: 'stable-4.16' },
      proposed: '4.16.1', // head — no deployment attributes to the new channel
      defaultChecked: false,
    });
  });

  it('uses the deployed floor as add-channel minVersion when clusters already run it', () => {
    const s = snap({
      packages: {
        'odf-operator': {
          deployments: [dep('c1', '4.15.2'), dep('c2', '4.16.0')],
        },
      },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.15' }]), s, CATALOG);
    const add = result.suggestions.find(x => x.kind === 'add-channel');
    expect(add?.proposed).toBe('4.16.0');
  });
});

describe('add-operator for deployed-but-unmirrored packages', () => {
  it('suggests adding a deployed package missing from the ISC, with per-channel floors', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.16',
            channelVersions: {
              'stable-4.15': ['4.15.0', '4.15.2'],
              'stable-4.16': ['4.16.0', '4.16.1'],
            },
          },
          {
            name: 'gitops-operator',
            defaultChannel: 'gitops-1.14',
            channelVersions: {
              'gitops-1.13': ['1.13.0'],
              'gitops-1.14': ['1.14.0', '1.14.2'],
            },
          },
        ],
      },
    });
    const s = snap({
      packages: {
        'odf-operator': { deployments: [dep('c1', '4.16.0')] },
        'gitops-operator': { deployments: [dep('c1', '1.14.0'), dep('c2', '1.14.2')] },
      },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.16' }]), s, multi);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add).toMatchObject({
      path: { type: 'operator', catalog: CATALOG_URL, package: 'gitops-operator' },
      proposedChannels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
      defaultChecked: false,
    });
    expect(add!.evidence).toContain('missing from the ISC');
  });

  it('is not suppressed by an untrustworthy snapshot (additive)', () => {
    const badHub: HubSnapshotStatus = {
      ...OK_HUB, id: 'h2', name: 'hub-2', status: 'error', error: 'down',
    };
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'gitops-operator',
            defaultChannel: 'gitops-1.14',
            channelVersions: { 'gitops-1.14': ['1.14.0', '1.14.2'] },
          },
        ],
      },
    });
    const s = snap({
      hubs: [OK_HUB, badHub],
      packages: {
        'gitops-operator': { deployments: [dep('c1', '1.14.2')] },
      },
    });
    const config: IscConfig = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: { operators: [{ catalog: CATALOG_URL, packages: [] }] },
    };
    const result = reconcile(config, s, multi);
    expect(result.suggestions.some(x => x.kind === 'add-operator')).toBe(true);
  });

  it('warns instead of suggesting when no ISC catalog contains the deployed package', () => {
    const s = snap({
      packages: { 'mystery-op': { deployments: [dep('c1', '1.0.0')] } },
    });
    const result = reconcile(iscWith([{ name: 'stable-4.16' }]), s, CATALOG);
    expect(result.suggestions.some(x => x.kind === 'add-operator')).toBe(false);
    expect(result.warnings.some(w => w.includes('mystery-op'))).toBe(true);
  });

  it('routes the default-channel fallback to suggestion notes, not warnings', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'gitops-operator',
            defaultChannel: 'gitops-1.14',
            channelVersions: { 'gitops-1.14': ['1.14.0', '1.14.2'] },
          },
        ],
      },
    });
    // 1.13.9 is in no catalog channel → default-channel fallback message
    const s = snap({
      packages: { 'gitops-operator': { deployments: [dep('c1', '1.13.9')] } },
    });
    const config: IscConfig = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: { operators: [{ catalog: CATALOG_URL, packages: [] }] },
    };
    const result = reconcile(config, s, multi);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add?.notes).toBeDefined();
    expect(
      add!.notes!.some(n => n.includes('proposing the default channel')),
    ).toBe(true);
    expect(
      result.warnings.some(w => w.includes('proposing the default channel')),
    ).toBe(false);
  });

  it('routes the numeric-floor explanation to suggestion notes, not warnings', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'gitops-operator',
            defaultChannel: 'gitops-1.14',
            channelVersions: { 'gitops-1.14': ['1.14.0', '1.14.2'] },
          },
        ],
      },
    });
    // 1.14.0 attributes to gitops-1.14; 1.13.9 attributes to nothing
    const s = snap({
      packages: {
        'gitops-operator': {
          deployments: [dep('c1', '1.14.0'), dep('c2', '1.13.9')],
        },
      },
    });
    const config: IscConfig = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: { operators: [{ catalog: CATALOG_URL, packages: [] }] },
    };
    const result = reconcile(config, s, multi);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add?.proposedChannels).toEqual([
      { name: 'gitops-1.14', minVersion: '1.13.9' },
    ]);
    expect(add!.notes!.some(n => n.includes('numeric floor'))).toBe(true);
    expect(result.warnings.some(w => w.includes('numeric floor'))).toBe(false);
  });
});

describe('seed-from-empty ISC', () => {
  const EMPTY_ISC: IscConfig = {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: { operators: [] },
  };
  const URLS = new Map([['redhat-operator-index:v4.21', CATALOG_URL]]);

  it('seeds an add-operator suggestion choosing the channel that contains the deployed version', () => {
    const s = snap({
      packages: {
        'odf-operator': { deployments: [dep('c1', '4.15.0'), dep('c2', '4.15.2')] },
      },
    });
    // CATALOG: defaultChannel stable-4.16; stable-4.15 contains both versions
    const result = reconcile(EMPTY_ISC, s, CATALOG, URLS);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add).toMatchObject({
      path: { type: 'operator', catalog: CATALOG_URL, package: 'odf-operator' },
      proposedChannels: [{ name: 'stable-4.15', minVersion: '4.15.0' }],
      defaultChecked: false,
    });
    expect(add!.notes).toBeUndefined();
  });

  it('prefers the default channel when several channels contain deployed versions', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.16',
            channelVersions: {
              'stable-4.15': ['4.15.0', '4.16.0'],
              'stable-4.16': ['4.16.0', '4.16.1'],
            },
          },
        ],
      },
    });
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(EMPTY_ISC, s, multi, URLS);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add!.proposedChannels).toEqual([
      { name: 'stable-4.16', minVersion: '4.16.0' },
    ]);
  });

  it('falls back to the default channel with a note when no channel contains a deployed version', () => {
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.14.9')] } },
    });
    const result = reconcile(EMPTY_ISC, s, CATALOG, URLS);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add!.proposedChannels).toEqual([
      { name: 'stable-4.16', minVersion: '4.14.9' },
    ]);
    expect(
      add!.notes!.some(n => n.includes('proposing the default channel')),
    ).toBe(true);
    expect(
      result.warnings.some(w => w.includes('proposing the default channel')),
    ).toBe(false);
  });

  it('prefers redhat-operator-index over other catalogs and notes the choice', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'community-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.15',
            channelVersions: { 'stable-4.15': ['4.15.0'] },
          },
        ],
        'redhat-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.15',
            channelVersions: { 'stable-4.15': ['4.15.0'] },
          },
        ],
      },
    });
    const urls = new Map([
      ['redhat-operator-index:v4.21', CATALOG_URL],
      [
        'community-operator-index:v4.21',
        'registry.redhat.io/redhat/community-operator-index:v4.21',
      ],
    ]);
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.15.0')] } },
    });
    const result = reconcile(EMPTY_ISC, s, multi, urls);
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect((add!.path as { catalog: string }).catalog).toBe(CATALOG_URL);
    expect(add!.notes!.some(n => n.includes('chose'))).toBe(true);
  });

  it('prefers the newest redhat-operator-index version when several host the package', () => {
    const op = {
      name: 'odf-operator',
      defaultChannel: 'stable-4.15',
      channelVersions: { 'stable-4.15': ['4.15.0'] },
    };
    const multi = buildReconcileCatalog({
      operators: {
        // v4.9 sorts after v4.21 lexically — numeric tag compare must win
        'redhat-operator-index:v4.9': [op],
        'redhat-operator-index:v4.21': [op],
      },
    });
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.15.0')] } },
    });
    const result = reconcile(EMPTY_ISC, s, multi, new Map());
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect((add!.path as { catalog: string }).catalog).toBe(
      'registry.redhat.io/redhat/redhat-operator-index:v4.21',
    );
  });

  it('breaks catalog ties alphabetically when no redhat-operator-index candidate exists', () => {
    const multi = buildReconcileCatalog({
      operators: {
        'community-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.15',
            channelVersions: { 'stable-4.15': ['4.15.0'] },
          },
        ],
        'certified-operator-index:v4.21': [
          {
            name: 'odf-operator',
            defaultChannel: 'stable-4.15',
            channelVersions: { 'stable-4.15': ['4.15.0'] },
          },
        ],
      },
    });
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.15.0')] } },
    });
    const result = reconcile(EMPTY_ISC, s, multi, new Map());
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    // alphabetical: certified < community; URL derived from the key when no map entry
    expect((add!.path as { catalog: string }).catalog).toBe(
      'registry.redhat.io/redhat/certified-operator-index:v4.21',
    );
  });

  it('warns fleet-wide for a deployed package found in no catalog', () => {
    const s = snap({
      packages: { 'mystery-op': { deployments: [dep('c1', '1.0.0')] } },
    });
    const result = reconcile(EMPTY_ISC, s, CATALOG, URLS);
    expect(result.suggestions).toHaveLength(0);
    expect(
      result.warnings.some(
        w => w.includes('mystery-op') && w.includes('no bundled catalog'),
      ),
    ).toBe(true);
  });

  it('also seeds when mirror.operators is absent entirely', () => {
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(
      { kind: 'ImageSetConfiguration', apiVersion: 'mirror.openshift.io/v2alpha1' },
      s,
      CATALOG,
      URLS,
    );
    expect(result.suggestions.some(x => x.kind === 'add-operator')).toBe(true);
  });

  it('does not seed when the ISC has an operator entry, even with zero packages', () => {
    const config: IscConfig = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: { operators: [{ catalog: CATALOG_URL, packages: [] }] },
    };
    const s = snap({
      packages: { 'odf-operator': { deployments: [dep('c1', '4.16.0')] } },
    });
    const result = reconcile(config, s, CATALOG, URLS);
    // existing add-operator pass runs (ISC catalog hosts the package) —
    // same outcome, but via the non-seed path with per-channel floors
    const add = result.suggestions.find(x => x.kind === 'add-operator');
    expect(add!.evidence).toContain('missing from the ISC');
  });
});

describe('buildCatalogUrlMap', () => {
  it('maps catalog keys to index URLs and derives missing ones', () => {
    const urls = buildCatalogUrlMap({
      operators: {
        'redhat-operator-index:v4.21': [],
        'extra-index:v1': [],
      },
      index: {
        catalogs: [
          {
            catalog_type: 'redhat-operator-index',
            ocp_version: 'v4.21',
            catalog_url: 'registry.example/custom/redhat-operator-index:v4.21',
          },
        ],
      },
    });
    expect(urls.get('redhat-operator-index:v4.21')).toBe(
      'registry.example/custom/redhat-operator-index:v4.21',
    );
    expect(urls.get('extra-index:v1')).toBe(
      'registry.redhat.io/redhat/extra-index:v1',
    );
  });

  it('returns an empty map for null data', () => {
    expect(buildCatalogUrlMap(null).size).toBe(0);
  });
});

describe('platform reconciliation', () => {
  const platformIsc = (
    channels: { name: string; minVersion?: string; maxVersion?: string }[],
  ): IscConfig => ({
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: { platform: { channels } },
  });
  const cl = (cluster: string, v: string): ClusterInfo => ({
    cluster, hub: 'hub-1', openshiftVersion: v,
  });

  it('raises platform minVersion to the lowest matching cluster version', () => {
    const s = snap({ clusters: [cl('c1', '4.16.8'), cl('c2', '4.16.20')] });
    const result = reconcile(
      platformIsc([{ name: 'stable-4.16', minVersion: '4.16.2' }]),
      s,
      new Map(),
    );
    const raise = result.suggestions.find(
      x => x.kind === 'raise-platform-min-version',
    );
    expect(raise).toMatchObject({
      path: { type: 'platform-channel', channel: 'stable-4.16' },
      current: '4.16.2',
      proposed: '4.16.8',
      defaultChecked: true,
    });
  });

  it('flags platform drift when a cluster is below the configured minVersion', () => {
    const s = snap({ clusters: [cl('c1', '4.16.1')] });
    const result = reconcile(
      platformIsc([{ name: 'stable-4.16', minVersion: '4.16.5' }]),
      s,
      new Map(),
    );
    expect(
      result.suggestions.find(x => x.kind === 'lower-min-version-drift'),
    ).toMatchObject({ proposed: '4.16.1' });
  });

  it('warns instead of raising past a configured maxVersion', () => {
    const s = snap({ clusters: [cl('c1', '4.16.8')] });
    const result = reconcile(
      platformIsc([
        { name: 'stable-4.16', minVersion: '4.16.2', maxVersion: '4.16.5' },
      ]),
      s,
      new Map(),
    );
    expect(result.suggestions).toHaveLength(0);
    expect(result.warnings.some(w => w.includes('maxVersion'))).toBe(true);
  });

  it('suggests removing a platform channel no cluster minor matches', () => {
    const s = snap({ clusters: [cl('c1', '4.16.8')] });
    const result = reconcile(
      platformIsc([{ name: 'stable-4.15' }, { name: 'stable-4.16' }]),
      s,
      new Map(),
    );
    expect(
      result.suggestions.find(x => x.kind === 'remove-channel'),
    ).toMatchObject({
      path: { type: 'platform-channel', channel: 'stable-4.15' },
      defaultChecked: false,
    });
  });

  it('warns about cluster minors no platform channel covers', () => {
    const s = snap({ clusters: [cl('c1', '4.17.3')] });
    const result = reconcile(
      platformIsc([{ name: 'stable-4.16' }]),
      s,
      new Map(),
    );
    expect(result.warnings.some(w => w.includes('4.17'))).toBe(true);
  });
});

describe('bump-catalog', () => {
  const BUMP_CATALOG = buildReconcileCatalog({
    operators: {
      'redhat-operator-index:v4.21': [
        {
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.21',
          channelVersions: { 'stable-4.21': ['4.21.0-rhodf', '4.21.8-rhodf'] },
        },
        {
          name: 'odf-operator',
          defaultChannel: 'stable-4.21',
          channelVersions: {
            'stable-4.21': ['4.21.0-rhodf'],
            'legacy-4.20': ['4.20.0-rhodf'],
          },
        },
      ],
      'redhat-operator-index:v4.22': [
        {
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.22',
          channelVersions: {
            'stable-4.21': ['4.21.0-rhodf', '4.21.8-rhodf'],
            'stable-4.22': ['4.22.0-rhodf'],
          },
        },
        {
          // odf-operator exists in v4.22 but WITHOUT legacy-4.20 → straggler
          name: 'odf-operator',
          defaultChannel: 'stable-4.22',
          channelVersions: {
            'stable-4.21': ['4.21.0-rhodf'],
            'stable-4.22': ['4.22.0-rhodf'],
          },
        },
      ],
    },
  });
  const OLD_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';
  const NEW_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.22';

  function bumpIsc(packages: Array<{
    name: string;
    channels: { name: string; minVersion?: string }[];
  }>): IscConfig {
    return {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: { operators: [{ catalog: OLD_URL, packages }] },
    };
  }

  it('emits a bump when a deployed version only attributes in a newer tag', () => {
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21', minVersion: '4.21.8-rhodf' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('local-cluster', '4.22.0-rhodf')] } } }),
      BUMP_CATALOG,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump).toBeDefined();
    expect(bump).toMatchObject({
      id: `bump-catalog|${OLD_URL}||`,
      path: { type: 'catalog', catalog: OLD_URL },
      current: 'v4.21',
      proposed: 'v4.22',
      proposedCatalog: NEW_URL,
      movedPackages: ['cephcsi-operator'],
      defaultChecked: false,
    });
    expect(bump!.evidence).toContain('4.22.0-rhodf');
    expect(bump!.evidence).toContain('local-cluster @ hub-1');
  });

  it('suppresses the numeric-floor raise, remove-channel, and warning for moved packages', () => {
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21', minVersion: '4.21.8-rhodf' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('local-cluster', '4.22.0-rhodf')] } } }),
      BUMP_CATALOG,
    );
    expect(result.suggestions.some(s => s.kind === 'raise-min-version')).toBe(false);
    expect(result.suggestions.some(s => s.kind === 'remove-channel')).toBe(false);
    expect(result.warnings.some(w => w.includes('are in no catalog channel'))).toBe(false);
  });

  it('does not emit a bump when every deployed version attributes on the selected tag', () => {
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.21.8-rhodf')] } } }),
      BUMP_CATALOG,
    );
    expect(result.suggestions.some(s => s.kind === 'bump-catalog')).toBe(false);
  });

  it('does not emit a bump when no newer tag attributes the version, keeping the fallback', () => {
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21', minVersion: '4.21.0-rhodf' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '9.9.9-nowhere')] } } }),
      BUMP_CATALOG,
    );
    expect(result.suggestions.some(s => s.kind === 'bump-catalog')).toBe(false);
    // existing numeric-fallback behavior still applies
    expect(result.warnings.some(w => w.includes('are in no catalog channel'))).toBe(true);
  });

  it('keeps a package whose ISC channel is missing from the target tag as a straggler', () => {
    const result = reconcile(
      bumpIsc([
        { name: 'cephcsi-operator', channels: [{ name: 'stable-4.21', minVersion: '4.21.8-rhodf' }] },
        { name: 'odf-operator', channels: [{ name: 'legacy-4.20', minVersion: '4.20.0-rhodf' }] },
      ]),
      snap({
        packages: {
          'cephcsi-operator': { deployments: [dep('local-cluster', '4.22.0-rhodf')] },
          'odf-operator': { deployments: [dep('c2', '4.20.0-rhodf')] },
        },
      }),
      BUMP_CATALOG,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump!.movedPackages).toEqual(['cephcsi-operator']);
    expect(bump!.evidence).toContain('keeps 1');
  });

  // old ISC channel absent from the target tag but unused by any deployment,
  // deployed version lives in a target channel → move with a channel rewrite
  const DEAD_CH = buildReconcileCatalog({
    operators: {
      'redhat-operator-index:v4.21': [{
        name: 'cephcsi-operator',
        defaultChannel: 'stable-4.21',
        channelVersions: { 'gone-4.19': ['4.19.0-rhodf'], 'stable-4.21': ['4.21.8-rhodf'] },
      }],
      'redhat-operator-index:v4.22': [{
        name: 'cephcsi-operator',
        defaultChannel: 'stable-4.22',
        channelVersions: { 'stable-4.21': ['4.21.8-rhodf'], 'stable-4.22': ['4.22.0-rhodf'] },
      }],
    },
  });

  it('bumps with a channel rewrite when the ISC channel is dead and the version lives in a target channel', () => {
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'gone-4.19' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.22.0-rhodf')] } } }),
      DEAD_CH,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump).toBeDefined();
    expect(bump!.movedPackages).toEqual(['cephcsi-operator']);
    expect(bump!.channelRewrites).toEqual({
      'cephcsi-operator': [{ name: 'stable-4.22', minVersion: '4.22.0-rhodf' }],
    });
    expect(bump!.notes!.some(n => n.includes('gone-4.19'))).toBe(true);
    // rewrite replaces the bogus fallback raise entirely
    expect(result.suggestions.some(s => s.kind === 'raise-min-version')).toBe(false);
  });

  it('keeps existing target channels verbatim and only appends the covering channel', () => {
    const result = reconcile(
      bumpIsc([{
        name: 'cephcsi-operator',
        channels: [{ name: 'stable-4.21', minVersion: '4.21.8-rhodf' }, { name: 'gone-4.19' }],
      }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.22.0-rhodf')] } } }),
      DEAD_CH,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump!.channelRewrites).toEqual({
      'cephcsi-operator': [
        { name: 'stable-4.21', minVersion: '4.21.8-rhodf' },
        { name: 'stable-4.22', minVersion: '4.22.0-rhodf' },
      ],
    });
  });

  it('does not rewrite channels when the snapshot is untrustworthy', () => {
    const badHub: HubSnapshotStatus = {
      ...OK_HUB, id: 'h2', name: 'hub-2', status: 'error', error: 'down',
    };
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'gone-4.19' }] }]),
      snap({
        hubs: [OK_HUB, badHub],
        packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.22.0-rhodf')] } },
      }),
      DEAD_CH,
    );
    expect(result.suggestions.some(s => s.kind === 'bump-catalog')).toBe(false);
  });

  it('never proposes a fallback minVersion above the channel head', () => {
    // numaresources case with no newer tag synced: deployed 4.22.1, channel
    // "4.21" tops out at 4.21.3 — old behavior proposed minVersion 4.22.1
    // into a channel that cannot contain it
    const SINGLE = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [{
          name: 'numaresources-operator',
          defaultChannel: '4.21',
          channelVersions: { '4.21': ['4.21.0', '4.21.3'] },
        }],
      },
    });
    const result = reconcile(
      bumpIsc([{ name: 'numaresources-operator', channels: [{ name: '4.21', minVersion: '4.21.3' }] }]),
      snap({ packages: { 'numaresources-operator': { deployments: [dep('c1', '4.22.1')] } } }),
      SINGLE,
    );
    expect(result.suggestions.some(s => s.kind === 'raise-min-version')).toBe(false);
    expect(result.warnings.some(w => w.includes('4.22.1'))).toBe(true);
  });

  it('targets the newest synced tag that attributes all bumpable versions', () => {
    const THREE = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [{
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.21',
          channelVersions: { 'stable-4.21': ['4.21.8-rhodf'] },
        }],
        'redhat-operator-index:v4.22': [{
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.22',
          channelVersions: { 'stable-4.21': ['4.21.8-rhodf'], 'stable-4.22': ['4.22.0-rhodf'] },
        }],
        'redhat-operator-index:v4.23': [{
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.23',
          channelVersions: { 'stable-4.21': ['4.21.8-rhodf'], 'stable-4.22': ['4.22.0-rhodf'], 'stable-4.23': ['4.23.0-rhodf'] },
        }],
      },
    });
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.22.0-rhodf')] } } }),
      THREE,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump!.proposed).toBe('v4.23');
    expect(bump!.proposedCatalog).toBe('registry.redhat.io/redhat/redhat-operator-index:v4.23');
  });

  it('falls back to an older newer tag when the newest does not attribute the version', () => {
    const THREE = buildReconcileCatalog({
      operators: {
        'redhat-operator-index:v4.21': [{
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.21',
          channelVersions: { 'stable-4.21': ['4.21.8-rhodf'] },
        }],
        'redhat-operator-index:v4.22': [{
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.22',
          channelVersions: { 'stable-4.21': ['4.21.8-rhodf'], 'stable-4.22': ['4.22.0-rhodf'] },
        }],
        'redhat-operator-index:v4.23': [{
          // 4.22.0-rhodf pruned from v4.23 index
          name: 'cephcsi-operator',
          defaultChannel: 'stable-4.23',
          channelVersions: { 'stable-4.23': ['4.23.0-rhodf'] },
        }],
      },
    });
    const result = reconcile(
      bumpIsc([{ name: 'cephcsi-operator', channels: [{ name: 'stable-4.21' }] }]),
      snap({ packages: { 'cephcsi-operator': { deployments: [dep('c1', '4.22.0-rhodf')] } } }),
      THREE,
    );
    const bump = result.suggestions.find(s => s.kind === 'bump-catalog');
    expect(bump!.proposed).toBe('v4.22');
  });
});

describe('M3 alias map end-to-end (cincinnati-operator case)', () => {
  const catalogData = {
    operators: {
      'redhat-operator-index:v4.21': [
        {
          name: 'cincinnati-operator',
          defaultChannel: 'v1',
          channelVersions: { v1: ['4.3.0', '4.6.0', '4.9.0'] },
          availableVersions: ['4.3.0', '4.6.0', '4.9.0'],
          catalog: 'redhat-operator-index',
          csvNamePrefixes: ['update-service-operator'],
        },
      ],
    },
  };
  const outcomes: HubFetchOutcome[] = [
    {
      hub: { id: 'h1', name: 'prod', url: 'https://prod.example.com', token: 't' },
      status: 'ok',
      truncated: false,
      items: [
        { name: 'update-service-operator.v4.9.0', cluster: 'c1', phase: 'Succeeded' },
      ],
    },
  ];
  const config = {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    mirror: {
      operators: [
        {
          catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
          packages: [
            { name: 'cincinnati-operator', channels: [{ name: 'v1', minVersion: '4.6.0' }] },
          ],
        },
      ],
    },
  };

  it('attributes aliased deployments to the catalog package — no spurious suggestions', () => {
    const snapshot = buildSnapshot(
      outcomes,
      buildCatalogLookup(catalogData),
      '2026-07-07T12:00:00.000Z',
      buildAliasLookup(catalogData),
    );
    const result = reconcile(config, snapshot, buildReconcileCatalog(catalogData));

    // M2's spurious artifacts must be gone:
    expect(result.suggestions.filter(s => s.kind === 'reset-unused-operator')).toEqual([]);
    expect(result.warnings.filter(w => w.includes('update-service-operator'))).toEqual([]);
    expect(result.noData).toEqual([]);
    // and the deployment drives a real floor suggestion:
    const raise = result.suggestions.find(s => s.kind === 'raise-min-version');
    expect(raise?.path).toMatchObject({ package: 'cincinnati-operator', channel: 'v1' });
    expect(raise?.proposed).toBe('4.9.0');
  });
});
