import { describe, it, expect } from 'vitest';
import {
  resolveDirectDependencies,
  resolveDependencyClosure,
  type CatalogDependencyMap,
} from '../../server/catalogDependencies';

const DEPS: CatalogDependencyMap = {
  'odf-dependencies': [
    { packageName: 'cephcsi-operator', versionRange: '4.22.0-rhodf' },
    { packageName: 'rook-ceph-operator', versionRange: '4.22.0-rhodf' },
  ],
  'devspaces': [{ packageName: 'devworkspace-operator', versionRange: '>=0.12.0' }],
  'mta-operator': [{ packageName: 'rhbk-operator', versionRange: '>=26.0.1' }],
};

describe('resolveDirectDependencies', () => {
  it('returns direct dependencies of a plain parent', () => {
    const r = resolveDirectDependencies(DEPS, 'devspaces');
    expect(r.refs.map(d => d.packageName)).toEqual(['devworkspace-operator']);
    expect(r.conventionPackage).toBeNull();
  });

  it('finds the -dependencies convention package via the -operator base name', () => {
    const r = resolveDirectDependencies(DEPS, 'odf-operator');
    expect(r.conventionPackage).toBe('odf-dependencies');
    expect(r.refs.map(d => d.packageName)).toEqual([
      'cephcsi-operator',
      'rook-ceph-operator',
    ]);
  });

  it('merges direct deps with convention-package deps and dedupes', () => {
    const deps: CatalogDependencyMap = {
      'foo': [{ packageName: 'shared' }],
      'foo-dependencies': [{ packageName: 'shared' }, { packageName: 'extra' }],
    };
    const r = resolveDirectDependencies(deps, 'foo');
    expect(r.refs.map(d => d.packageName)).toEqual(['shared', 'extra']);
    expect(r.conventionPackage).toBe('foo-dependencies');
  });

  it('returns empty for an unknown parent', () => {
    const r = resolveDirectDependencies(DEPS, 'nope');
    expect(r.refs).toEqual([]);
    expect(r.conventionPackage).toBeNull();
  });
});

describe('resolveDependencyClosure', () => {
  it('includes dep names plus the convention package, parent excluded', () => {
    expect(resolveDependencyClosure(DEPS, 'odf-operator')).toEqual([
      'cephcsi-operator',
      'rook-ceph-operator',
      'odf-dependencies',
    ]);
  });

  it('never lists the parent itself', () => {
    const deps: CatalogDependencyMap = {
      'self': [{ packageName: 'self' }, { packageName: 'other' }],
    };
    expect(resolveDependencyClosure(deps, 'self')).toEqual(['other']);
  });

  it('returns empty when no dependency data matches', () => {
    expect(resolveDependencyClosure(DEPS, 'cephcsi-operator')).toEqual([]);
  });
});
