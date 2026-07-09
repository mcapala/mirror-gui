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

  it('skips suggestions whose path no longer exists', () => {
    const result = applySuggestions(baseConfig(), [{
      ...raise,
      path: { ...raise.path, package: 'gone-operator' } as Suggestion['path'],
    }]);
    expect(result.applied).toBe(0);
    expect(result.skipped[0]).toContain('gone-operator');
  });
});

describe('remove-operator', () => {
  const OLD_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';
  const NEW_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.22';

  const removeSuggestion = (pkg: string): Suggestion => ({
    id: `remove-operator|${OLD_URL}|${pkg}|`,
    kind: 'remove-operator',
    path: { type: 'operator', catalog: OLD_URL, package: pkg },
    current: 'stable-4.21@4.21.8-rhodf',
    proposed: null,
    evidence: 'test',
    defaultChecked: false,
  });

  const addSuggestion = (pkg: string): Suggestion => ({
    id: `add-operator|${NEW_URL}|${pkg}|`,
    kind: 'add-operator',
    path: { type: 'operator', catalog: NEW_URL, package: pkg },
    current: null,
    proposed: 'stable-4.22@4.22.0-rhodf',
    proposedChannels: [{ name: 'stable-4.22', minVersion: '4.22.0-rhodf' }],
    evidence: 'test',
    defaultChecked: true,
  });

  function configWith(packages: string[]): ImageSetConfig {
    return {
      mirror: {
        platform: { channels: [] },
        operators: [{
          catalog: OLD_URL,
          availableOperators: [],
          packages: packages.map(name => ({
            name,
            channels: [{ name: 'stable-4.21', minVersion: '4.21.8-rhodf' }],
          })),
        }],
        additionalImages: [],
      },
    } as unknown as ImageSetConfig;
  }

  it('removes the package and deletes the emptied entry', () => {
    const result = applySuggestions(configWith(['cephcsi-operator']), [
      removeSuggestion('cephcsi-operator'),
    ]);
    expect(result.applied).toBe(1);
    expect(result.config.mirror.operators).toHaveLength(0);
  });

  it('keeps the entry when other packages remain', () => {
    const result = applySuggestions(configWith(['cephcsi-operator', 'odf-operator']), [
      removeSuggestion('cephcsi-operator'),
    ]);
    expect(result.config.mirror.operators[0].packages.map(p => p.name)).toEqual([
      'odf-operator',
    ]);
  });

  it('applies add-only as a transition split: package under both catalogs', () => {
    const result = applySuggestions(configWith(['cephcsi-operator']), [
      addSuggestion('cephcsi-operator'),
    ]);
    expect(result.config.mirror.operators).toHaveLength(2);
    expect(
      result.config.mirror.operators.map(e => e.catalog).sort(),
    ).toEqual([OLD_URL, NEW_URL]);
  });

  it('applies add + remove as a full move even when the remove sorts first in input', () => {
    const result = applySuggestions(configWith(['cephcsi-operator']), [
      removeSuggestion('cephcsi-operator'),
      addSuggestion('cephcsi-operator'),
    ]);
    expect(result.applied).toBe(2);
    expect(result.config.mirror.operators).toHaveLength(1);
    expect(result.config.mirror.operators[0].catalog).toBe(NEW_URL);
    expect(result.config.mirror.operators[0].packages[0].channels).toEqual([
      { name: 'stable-4.22', minVersion: '4.22.0-rhodf' },
    ]);
  });

  it('skips with a note when the package is already gone', () => {
    const result = applySuggestions(configWith(['odf-operator']), [
      removeSuggestion('cephcsi-operator'),
    ]);
    expect(result.applied).toBe(0);
    expect(result.skipped.some(s => s.includes('cephcsi-operator'))).toBe(true);
  });
});
