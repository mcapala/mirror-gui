import { describe, it, expect } from 'vitest';
import { applySuggestions } from '../../src/components/fleetUpdates/applySuggestions';
import type { ImageSetConfig } from '../../src/components/MirrorConfig';
import type { Suggestion } from '../../src/components/fleetUpdates/types';

const CATALOG_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';

function baseConfig(): ImageSetConfig {
  return {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    archiveSize: '',
    mirror: {
      platform: {
        channels: [
          {
            name: 'stable-4.16', minVersion: '4.16.2', maxVersion: '',
            type: 'ocp', shortestPath: false,
          },
        ],
        graph: true,
      },
      operators: [
        {
          catalog: CATALOG_URL,
          packages: [
            {
              name: 'odf-operator',
              channels: [
                { name: 'stable-4.15', minVersion: '' },
                { name: 'stable-4.16', minVersion: '4.16.0' },
              ],
            },
          ],
        },
      ],
      additionalImages: [],
      helm: { repositories: [] },
    },
  };
}

const raise: Suggestion = {
  id: 'r1', kind: 'raise-min-version',
  path: { type: 'operator-channel', catalog: CATALOG_URL, package: 'odf-operator', channel: 'stable-4.16' },
  current: '4.16.0', proposed: '4.16.1', evidence: '', defaultChecked: true,
};

describe('applySuggestions', () => {
  it('raises an operator channel minVersion by path and does not mutate the input', () => {
    const config = baseConfig();
    const result = applySuggestions(config, [raise]);
    expect(result.applied).toBe(1);
    expect(
      result.config.mirror.operators[0].packages[0].channels[1].minVersion,
    ).toBe('4.16.1');
    expect(config.mirror.operators[0].packages[0].channels[1].minVersion).toBe('4.16.0');
  });

  it('raises a platform channel minVersion', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'p1', kind: 'raise-platform-min-version',
      path: { type: 'platform-channel', channel: 'stable-4.16' },
      current: '4.16.2', proposed: '4.16.8', evidence: '', defaultChecked: true,
    }]);
    expect(result.config.mirror.platform.channels[0].minVersion).toBe('4.16.8');
  });

  it('adds a channel with the proposed minVersion', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'a1', kind: 'add-channel',
      path: { type: 'operator-channel', catalog: CATALOG_URL, package: 'odf-operator', channel: 'stable-4.17' },
      current: null, proposed: '4.17.0', evidence: '', defaultChecked: false,
    }]);
    expect(result.config.mirror.operators[0].packages[0].channels).toContainEqual(
      { name: 'stable-4.17', minVersion: '4.17.0' },
    );
  });

  it('removes an operator channel but refuses to empty the package', () => {
    const removeOne: Suggestion = {
      id: 'd1', kind: 'remove-channel',
      path: { type: 'operator-channel', catalog: CATALOG_URL, package: 'odf-operator', channel: 'stable-4.15' },
      current: null, proposed: null, evidence: '', defaultChecked: false,
    };
    const removeOther: Suggestion = {
      ...removeOne, id: 'd2',
      path: { ...removeOne.path, channel: 'stable-4.16' } as Suggestion['path'],
    };
    const result = applySuggestions(baseConfig(), [removeOne, removeOther]);
    expect(result.applied).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.config.mirror.operators[0].packages[0].channels).toHaveLength(1);
  });

  it('applies a channel swap (remove + add in one batch) regardless of order', () => {
    const config = baseConfig();
    config.mirror.operators[0].packages[0].channels = [
      { name: 'stable-4.21', minVersion: '' },
    ];
    const remove: Suggestion = {
      id: 'sw1', kind: 'remove-channel',
      path: { type: 'operator-channel', catalog: CATALOG_URL, package: 'odf-operator', channel: 'stable-4.21' },
      current: null, proposed: null, evidence: '', defaultChecked: false,
    };
    const add: Suggestion = {
      id: 'sw2', kind: 'add-channel',
      path: { type: 'operator-channel', catalog: CATALOG_URL, package: 'odf-operator', channel: 'stable-4.22' },
      current: null, proposed: '4.22.0', evidence: '', defaultChecked: false,
    };
    const result = applySuggestions(config, [remove, add]);
    expect(result.applied).toBe(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.config.mirror.operators[0].packages[0].channels).toEqual([
      { name: 'stable-4.22', minVersion: '4.22.0' },
    ]);
  });

  it('removes a platform channel', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'dp', kind: 'remove-channel',
      path: { type: 'platform-channel', channel: 'stable-4.16' },
      current: null, proposed: null, evidence: '', defaultChecked: false,
    }]);
    expect(result.config.mirror.platform.channels).toHaveLength(0);
  });

  it('resets an unused operator to the proposed channel list', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'rs', kind: 'reset-unused-operator',
      path: { type: 'operator', catalog: CATALOG_URL, package: 'odf-operator' },
      current: null, proposed: 'stable-4.17@4.17.1',
      proposedChannels: [{ name: 'stable-4.17', minVersion: '4.17.1' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(result.config.mirror.operators[0].packages[0].channels).toEqual([
      { name: 'stable-4.17', minVersion: '4.17.1' },
    ]);
  });

  it('adds a missing operator with its proposed channels', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'ao', kind: 'add-operator',
      path: { type: 'operator', catalog: CATALOG_URL, package: 'gitops-operator' },
      current: null, proposed: 'gitops-1.14@1.14.0',
      proposedChannels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(result.applied).toBe(1);
    expect(result.config.mirror.operators[0].packages).toContainEqual({
      name: 'gitops-operator',
      channels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
    });
  });

  it('skips add-operator when the package already exists', () => {
    const existing = applySuggestions(baseConfig(), [{
      id: 'ao2', kind: 'add-operator',
      path: { type: 'operator', catalog: CATALOG_URL, package: 'odf-operator' },
      current: null, proposed: 'x',
      proposedChannels: [{ name: 'stable-4.16', minVersion: '4.16.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(existing.applied).toBe(0);
    expect(existing.skipped[0]).toContain('odf-operator');
  });

  it('creates the catalog entry for add-operator when the ISC lacks it', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'ao3', kind: 'add-operator',
      path: { type: 'operator', catalog: 'quay.io/other/index:v1', package: 'gitops-operator' },
      current: null, proposed: 'gitops-1.14@1.14.0',
      proposedChannels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(result.applied).toBe(1);
    const entry = result.config.mirror.operators.find(
      e => e.catalog === 'quay.io/other/index:v1',
    );
    expect(entry).toMatchObject({
      catalogVersion: 'v1',
      availableOperators: [],
      packages: [
        {
          name: 'gitops-operator',
          channels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
        },
      ],
    });
  });

  it('still skips non-add-operator suggestions on a missing catalog', () => {
    const result = applySuggestions(baseConfig(), [{
      id: 'rs2', kind: 'reset-unused-operator',
      path: { type: 'operator', catalog: 'quay.io/other/index:v1', package: 'gitops-operator' },
      current: null, proposed: 'x',
      proposedChannels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(result.applied).toBe(0);
    expect(result.skipped[0]).toContain('quay.io/other/index:v1');
  });

  const NEW_CATALOG_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.22';

  function bumpSuggestion(moved: string[]): Suggestion {
    return {
      id: `bump-catalog|${CATALOG_URL}||`, kind: 'bump-catalog',
      path: { type: 'catalog', catalog: CATALOG_URL },
      current: 'v4.21', proposed: 'v4.22',
      proposedCatalog: NEW_CATALOG_URL,
      movedPackages: moved,
      evidence: '', defaultChecked: false,
    };
  }

  it('bump-catalog moves packages into a newly created target entry', () => {
    const result = applySuggestions(baseConfig(), [bumpSuggestion(['odf-operator'])]);
    expect(result.applied).toBe(1);
    expect(result.skipped).toHaveLength(0);
    // old entry emptied → removed
    expect(result.config.mirror.operators).toHaveLength(1);
    expect(result.config.mirror.operators[0]).toMatchObject({
      catalog: NEW_CATALOG_URL,
      catalogVersion: 'v4.22',
      availableOperators: [],
    });
    // package moved verbatim, channels and minVersions preserved
    expect(result.config.mirror.operators[0].packages).toEqual([
      {
        name: 'odf-operator',
        channels: [
          { name: 'stable-4.15', minVersion: '' },
          { name: 'stable-4.16', minVersion: '4.16.0' },
        ],
      },
    ]);
  });

  it('bump-catalog reuses an existing target entry and keeps stragglers on the old one', () => {
    const config = baseConfig();
    config.mirror.operators[0].packages.push({
      name: 'straggler-operator',
      channels: [{ name: 'old-channel', minVersion: '' }],
    });
    config.mirror.operators.push({
      catalog: NEW_CATALOG_URL,
      packages: [{ name: 'existing-op', channels: [{ name: 'ch', minVersion: '' }] }],
    });
    const result = applySuggestions(config, [bumpSuggestion(['odf-operator'])]);
    expect(result.applied).toBe(1);
    const oldEntry = result.config.mirror.operators.find(e => e.catalog === CATALOG_URL);
    const newEntry = result.config.mirror.operators.find(e => e.catalog === NEW_CATALOG_URL);
    expect(oldEntry!.packages.map(p => p.name)).toEqual(['straggler-operator']);
    expect(newEntry!.packages.map(p => p.name)).toEqual(['existing-op', 'odf-operator']);
    // no duplicate entry created
    expect(result.config.mirror.operators).toHaveLength(2);
  });

  it('bump-catalog skips missing packages but moves the rest', () => {
    const result = applySuggestions(baseConfig(), [
      bumpSuggestion(['gone-operator', 'odf-operator']),
    ]);
    expect(result.applied).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain('gone-operator');
    const newEntry = result.config.mirror.operators.find(e => e.catalog === NEW_CATALOG_URL);
    expect(newEntry!.packages.map(p => p.name)).toEqual(['odf-operator']);
  });

  it('bump-catalog skips entirely when the old entry is missing', () => {
    const result = applySuggestions(baseConfig(), [{
      ...bumpSuggestion(['odf-operator']),
      path: { type: 'catalog', catalog: 'quay.io/other/index:v1' },
    }]);
    expect(result.applied).toBe(0);
    expect(result.skipped[0]).toContain('quay.io/other/index:v1');
  });

  it('applies raises before the bump so moved packages carry the new minVersion', () => {
    // bump listed FIRST to prove reordering, raise second
    const result = applySuggestions(baseConfig(), [
      bumpSuggestion(['odf-operator']),
      raise,
    ]);
    expect(result.applied).toBe(2);
    const newEntry = result.config.mirror.operators.find(e => e.catalog === NEW_CATALOG_URL);
    const ch = newEntry!.packages[0].channels.find(c => c.name === 'stable-4.16');
    expect(ch!.minVersion).toBe('4.16.1');
  });

  it('skips suggestions whose path no longer exists', () => {
    const result = applySuggestions(baseConfig(), [{
      ...raise,
      path: { ...raise.path, package: 'gone-operator' } as Suggestion['path'],
    }]);
    expect(result.applied).toBe(0);
    expect(result.skipped[0]).toContain('gone-operator');
  });
});
