import { describe, it, expect } from 'vitest';
import {
  buildSnapshot,
  buildCatalogLookup,
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
    expect(snap.schemaVersion).toBe(1);
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
