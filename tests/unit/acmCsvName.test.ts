import { describe, it, expect } from 'vitest';
import { parseCsvName } from '../../server/acm/csvName.js';

describe('parseCsvName', () => {
  it('parses the standard <package>.v<version> form', () => {
    expect(parseCsvName('advanced-cluster-management.v2.10.3')).toEqual({
      packageName: 'advanced-cluster-management',
      version: '2.10.3',
    });
  });

  it('parses the no-v form used by some operators', () => {
    expect(parseCsvName('costmanagement-metrics-operator.4.3.1')).toEqual({
      packageName: 'costmanagement-metrics-operator',
      version: '4.3.1',
    });
  });

  it('keeps build metadata in the version', () => {
    expect(
      parseCsvName('openshift-gitops-operator.v1.11.0-0.1698000000.p')
    ).toEqual({
      packageName: 'openshift-gitops-operator',
      version: '1.11.0-0.1698000000.p',
    });
  });

  it('handles package names containing dots (non-greedy stop at version)', () => {
    expect(parseCsvName('foo.bar.v1.2.3')).toEqual({
      packageName: 'foo.bar',
      version: '1.2.3',
    });
  });

  it('returns null for names without an x.y version', () => {
    expect(parseCsvName('garbage')).toBeNull();
    expect(parseCsvName('noversion.vabc')).toBeNull();
    expect(parseCsvName('single-number.v3')).toBeNull();
    expect(parseCsvName('')).toBeNull();
  });
});
