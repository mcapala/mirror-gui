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

  it('skips add-operator when the package already exists or the catalog entry is gone', () => {
    const existing = applySuggestions(baseConfig(), [{
      id: 'ao2', kind: 'add-operator',
      path: { type: 'operator', catalog: CATALOG_URL, package: 'odf-operator' },
      current: null, proposed: 'x',
      proposedChannels: [{ name: 'stable-4.16', minVersion: '4.16.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(existing.applied).toBe(0);
    expect(existing.skipped[0]).toContain('odf-operator');

    const noCatalog = applySuggestions(baseConfig(), [{
      id: 'ao3', kind: 'add-operator',
      path: { type: 'operator', catalog: 'quay.io/other/index:v1', package: 'gitops-operator' },
      current: null, proposed: 'x',
      proposedChannels: [{ name: 'gitops-1.14', minVersion: '1.14.0' }],
      evidence: '', defaultChecked: false,
    }]);
    expect(noCatalog.applied).toBe(0);
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
