import { describe, it, expect } from 'vitest';
import { computeIscDiff, diffCounts } from '../../src/components/fleetUpdates/iscDiff';
import { applySuggestions } from '../../src/components/fleetUpdates/applySuggestions';
import type { ImageSetConfig } from '../../src/components/MirrorConfig';
import type { Suggestion } from '../../src/components/fleetUpdates/types';

const CATALOG_URL = 'registry.redhat.io/redhat/redhat-operator-index:v4.21';

function config(): ImageSetConfig {
  return {
    kind: 'ImageSetConfiguration',
    apiVersion: 'mirror.openshift.io/v2alpha1',
    archiveSize: '',
    mirror: {
      platform: { channels: [], graph: false },
      operators: [{
        catalog: CATALOG_URL,
        packages: [{
          name: 'odf-operator',
          channels: [{ name: 'stable-4.16', minVersion: '4.16.0' }],
        }],
      }],
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

describe('computeIscDiff', () => {
  it('returns a single unchanged part when nothing is selected', () => {
    const before = config();
    const parts = computeIscDiff(before, applySuggestions(before, []).config);
    expect(parts.every(p => !p.added && !p.removed)).toBe(true);
    expect(diffCounts(parts)).toEqual({ added: 0, removed: 0 });
  });

  it('shows a minVersion raise as one removed and one added line', () => {
    const before = config();
    const after = applySuggestions(before, [raise]).config;
    const parts = computeIscDiff(before, after);
    const removed = parts.filter(p => p.removed).map(p => p.value).join('');
    const added = parts.filter(p => p.added).map(p => p.value).join('');
    expect(removed).toContain('minVersion: 4.16.0');
    expect(added).toContain('minVersion: 4.16.1');
    expect(diffCounts(parts)).toEqual({ added: 1, removed: 1 });
  });
});
