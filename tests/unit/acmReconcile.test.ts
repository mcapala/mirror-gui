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
