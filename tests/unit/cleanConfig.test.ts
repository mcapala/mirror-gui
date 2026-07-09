import { describe, it, expect } from 'vitest';
import { buildCleanConfig } from '../../src/components/cleanConfig';
import type { ImageSetConfig } from '../../src/components/MirrorConfig';

const CATALOG_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';

function fullConfig(): ImageSetConfig {
  return {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    archiveSize: '4',
    mirror: {
      platform: {
        channels: [{
          name: 'stable-4.16', minVersion: '4.16.2', maxVersion: '',
          type: 'ocp', shortestPath: false,
        }],
        graph: true,
      },
      operators: [{
        catalog: CATALOG_URL,
        packages: [{
          name: 'odf-operator',
          channels: [{ name: 'stable-4.16', minVersion: '4.16.0' }],
        }],
      }],
      additionalImages: [{ name: 'registry.example.com/app:1' }],
      helm: { repositories: [] },
    },
  };
}

describe('buildCleanConfig', () => {
  it('serializes a full config with defaults (no digests, no operator metadata)', () => {
    expect(buildCleanConfig(fullConfig())).toEqual({
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      archiveSize: 4,
      mirror: {
        platform: {
          channels: [{ name: 'stable-4.16', type: 'ocp', minVersion: '4.16.2' }],
          graph: true,
        },
        operators: [{
          catalog: CATALOG_URL,
          packages: [{
            name: 'odf-operator',
            channels: [{ name: 'stable-4.16', minVersion: '4.16.0' }],
          }],
        }],
        additionalImages: [{ name: 'registry.example.com/app:1' }],
      },
    });
  });

  it('drops empty sections and invalid archiveSize', () => {
    const config = fullConfig();
    config.archiveSize = 'abc';
    config.mirror.platform.channels = [];
    config.mirror.additionalImages = [];
    config.mirror.operators = [];
    expect(buildCleanConfig(config)).toEqual({
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: {},
    });
  });

  it('resolves digest refs when enabled', () => {
    const result = buildCleanConfig(fullConfig(), {
      useDigestRef: true,
      catalogDigestMap: { [CATALOG_URL]: 'sha256:abc123' },
    });
    expect(result.mirror.operators![0].catalog).toBe(
      'registry.redhat.io/redhat/redhat-operator-index@sha256:abc123',
    );
  });

  it('adds defaultChannel override when the catalog default is not selected', () => {
    const result = buildCleanConfig(fullConfig(), {
      detailedOperators: {
        [CATALOG_URL]: [{
          name: 'odf-operator',
          defaultChannel: 'stable-4.15',
          allChannels: ['stable-4.15', 'stable-4.16'],
        }],
      },
    });
    expect(result.mirror.operators![0].packages[0].defaultChannel).toBe('stable-4.16');
  });
});
