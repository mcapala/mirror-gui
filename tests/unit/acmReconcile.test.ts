import { describe, it, expect } from 'vitest';
import {
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
