import { describe, it, expect, vi } from 'vitest';
import {
  buildSnapshot,
  buildCatalogLookup,
  buildAliasLookup,
  type HubFetchOutcome,
} from '../../server/acm/aggregate.js';
import type { AcmHub, CatalogLookup } from '../../server/acm/types.js';

const hub = (id: string, name: string): AcmHub => ({
  id,
  name,
  url: `https://${name}.example.com`,
  token: 't',
});

const NOW = '2026-07-06T12:00:00.000Z';

const emptyCatalog: CatalogLookup = new Map();

describe('buildSnapshot', () => {
  it('filters non-Succeeded CSVs and dedups namespace copies', () => {
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        truncated: false,
        items: [
          { name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' },
          // namespace-copied duplicate — same cluster, same CSV name
          { name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' },
          { name: 'acm.v2.11.0', cluster: 'c1', phase: 'Installing' },
        ],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.packages['acm'].deployments).toEqual([
      { cluster: 'c1', hub: 'prod', version: '2.10.3', behind: false },
    ]);
    expect(snap.hubs[0]).toMatchObject({
      id: 'h1',
      status: 'ok',
      clusterCount: 1,
      skippedItems: 0,
    });
  });

  it('merges packages across hubs and computes min/max deployed', () => {
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [{ name: 'acm.v2.12.0', cluster: 'p1', phase: 'Succeeded' }],
      },
      {
        hub: hub('h2', 'dev'),
        status: 'ok',
        items: [{ name: 'acm.v2.10.3', cluster: 'd1', phase: 'Succeeded' }],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    const pkg = snap.packages['acm'];
    expect(pkg.minDeployed).toBe('2.10.3');
    expect(pkg.maxDeployed).toBe('2.12.0');
    expect(pkg.deployments[0].version).toBe('2.10.3'); // sorted ascending
  });

  it('drops and flags a failed hub without carrying stale data', () => {
    const outcomes: HubFetchOutcome[] = [
      { hub: hub('h1', 'prod'), status: 'error', error: 'hub unreachable' },
      {
        hub: hub('h2', 'dev'),
        status: 'ok',
        items: [{ name: 'acm.v2.10.3', cluster: 'd1', phase: 'Succeeded' }],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.hubs[0]).toMatchObject({
      status: 'error',
      error: 'hub unreachable',
      clusterCount: 0,
    });
    expect(snap.packages['acm'].deployments).toHaveLength(1);
  });

  it('counts malformed and unparseable items as skipped', () => {
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [
          { name: 'not-a-csv-name', cluster: 'c1', phase: 'Succeeded' },
          { name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' },
          {} as never,
        ],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.hubs[0].skippedItems).toBe(2);
    expect(Object.keys(snap.packages)).toEqual(['acm']);
  });

  it('joins the catalog: behind vs current, per-deployment behind flags', () => {
    const catalog: CatalogLookup = new Map([
      [
        'acm',
        { latestAvailable: '2.12.0', catalogSource: 'redhat-operator-index' },
      ],
    ]);
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [
          { name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' },
          { name: 'acm.v2.12.0', cluster: 'c2', phase: 'Succeeded' },
        ],
      },
    ];
    const snap = buildSnapshot(outcomes, catalog, NOW);
    const pkg = snap.packages['acm'];
    expect(pkg.status).toBe('behind');
    expect(pkg.latestAvailable).toBe('2.12.0');
    expect(pkg.deployments.find(d => d.cluster === 'c1')?.behind).toBe(true);
    expect(pkg.deployments.find(d => d.cluster === 'c2')?.behind).toBe(false);
  });

  it('marks packages missing from the catalog as unknown', () => {
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [
          { name: 'custom-op.v1.0.0', cluster: 'c1', phase: 'Succeeded' },
        ],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.packages['custom-op'].status).toBe('unknown');
    expect(snap.packages['custom-op'].latestAvailable).toBeNull();
  });

  it('propagates truncation and stamps refreshedAt/schemaVersion', () => {
    const outcomes: HubFetchOutcome[] = [
      { hub: hub('h1', 'prod'), status: 'ok', items: [], truncated: true },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.hubs[0].truncated).toBe(true);
    expect(snap.refreshedAt).toBe(NOW);
    expect(snap.schemaVersion).toBe(2);
  });

  it('collects deduplicated cluster OCP versions into snapshot.clusters', () => {
    const HUB = hub('h1', 'prod');
    const outcome: HubFetchOutcome = {
      hub: HUB,
      status: 'ok',
      items: [],
      clusterItems: [
        { name: 'c1', openshiftVersion: '4.16.8' },
        { name: 'c1', openshiftVersion: '4.16.8' }, // dup
        { name: 'c2', version: '4.15.2' },
        { name: 'c3' }, // no version → skipped
      ],
    };
    const snapshot = buildSnapshot([outcome], new Map(), NOW);
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.clusters).toEqual([
      { cluster: 'c1', hub: HUB.name, openshiftVersion: '4.16.8' },
      { cluster: 'c2', hub: HUB.name, openshiftVersion: '4.15.2' },
    ]);
    const hubStatus = snapshot.hubs[0];
    expect(hubStatus.skippedItems).toBe(1);
    expect(hubStatus.clusterCount).toBe(3); // c1, c2, c3 all seen
  });

  it('does not merge deployments when cluster/name contain the dedup separator ambiguously', () => {
    // "a b" + "c" vs "a" + "b c" must be two distinct deployments
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [
          { name: 'op.v1.0.0', cluster: 'a b', phase: 'Succeeded' },
          { name: 'op.v1.0.0', cluster: 'a', phase: 'Succeeded' },
        ],
      },
    ];
    const snap = buildSnapshot(outcomes, emptyCatalog, NOW);
    expect(snap.packages['op'].deployments).toHaveLength(2);
  });

  it('gives status unknown and keeps latestAvailable null when catalog latest is garbage', () => {
    const outcomes: HubFetchOutcome[] = [
      {
        hub: hub('h1', 'prod'),
        status: 'ok',
        items: [
          { name: 'op.v1.0.0', cluster: 'c1', phase: 'Succeeded' },
        ],
      },
    ];
    const catalog = new Map([
      ['op', { latestAvailable: 'not-a-version', catalogSource: 'x' }],
    ]);
    const snap = buildSnapshot(outcomes, catalog, NOW);
    expect(snap.packages['op'].status).toBe('unknown');
    expect(snap.packages['op'].latestAvailable).toBeNull();
  });
});

describe('buildCatalogLookup', () => {
  it('takes the highest available version across catalogs', () => {
    const lookup = buildCatalogLookup({
      operators: {
        'redhat-operator-index:v4.20': [
          {
            name: 'acm',
            availableVersions: ['2.10.0', '2.11.0'],
            catalog: 'redhat-operator-index',
          },
        ],
        'redhat-operator-index:v4.21': [
          {
            name: 'acm',
            availableVersions: ['2.11.0', '2.12.0'],
            catalog: 'redhat-operator-index',
          },
        ],
      },
    });
    expect(lookup.get('acm')).toEqual({
      latestAvailable: '2.12.0',
      catalogSource: 'redhat-operator-index',
    });
  });

  it('falls back to maxVersion and tolerates null input', () => {
    expect(buildCatalogLookup(null).size).toBe(0);
    const lookup = buildCatalogLookup({
      operators: {
        'community-operator-index:v4.21': [
          {
            name: 'foo',
            maxVersion: '1.2.3',
            catalog: 'community-operator-index',
          },
        ],
      },
    });
    expect(lookup.get('foo')?.latestAvailable).toBe('1.2.3');
  });
});

describe('buildAliasLookup', () => {
  it('maps csvNamePrefixes to their package name', () => {
    const lookup = buildAliasLookup({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'cincinnati-operator',
            availableVersions: ['4.9.0'],
            csvNamePrefixes: ['update-service-operator'],
          },
        ],
      },
    });
    expect(lookup.get('update-service-operator')).toBe('cincinnati-operator');
  });

  it('tolerates null input and operators without prefixes', () => {
    expect(buildAliasLookup(null).size).toBe(0);
    expect(
      buildAliasLookup({
        operators: {
          'redhat-operator-index:v4.21': [
            { name: 'acm', availableVersions: ['2.16.0'] },
          ],
        },
      }).size,
    ).toBe(0);
  });

  it('never shadows a real package name', () => {
    const lookup = buildAliasLookup({
      operators: {
        'redhat-operator-index:v4.21': [
          {
            name: 'operator-a',
            availableVersions: ['1.0.0'],
            csvNamePrefixes: ['operator-b'],
          },
          { name: 'operator-b', availableVersions: ['2.0.0'] },
        ],
      },
    });
    expect(lookup.has('operator-b')).toBe(false);
  });

  it('drops an ambiguous prefix claimed by two packages, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = buildAliasLookup({
      operators: {
        'redhat-operator-index:v4.21': [
          { name: 'pkg-one', availableVersions: ['1.0.0'], csvNamePrefixes: ['shared-prefix'] },
          { name: 'pkg-two', availableVersions: ['1.0.0'], csvNamePrefixes: ['shared-prefix'] },
        ],
      },
    });
    expect(lookup.has('shared-prefix')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('shared-prefix'));
    warn.mockRestore();
  });

  it('drops an ambiguous prefix that is also a real package name silently (literal wins)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = buildAliasLookup({
      operators: {
        'redhat-operator-index:v4.21': [
          { name: 'pkg-one', availableVersions: ['1.0.0'], csvNamePrefixes: ['operator-c'] },
          { name: 'pkg-two', availableVersions: ['1.0.0'], csvNamePrefixes: ['operator-c'] },
          { name: 'operator-c', availableVersions: ['3.0.0'] },
        ],
      },
    });
    expect(lookup.has('operator-c')).toBe(false);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not treat the same prefix->package pair across snapshots as a conflict', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const lookup = buildAliasLookup({
      operators: {
        'redhat-operator-index:v4.20': [
          { name: 'cincinnati-operator', availableVersions: ['4.6.0'], csvNamePrefixes: ['update-service-operator'] },
        ],
        'redhat-operator-index:v4.21': [
          { name: 'cincinnati-operator', availableVersions: ['4.9.0'], csvNamePrefixes: ['update-service-operator'] },
        ],
      },
    });
    expect(lookup.get('update-service-operator')).toBe('cincinnati-operator');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
