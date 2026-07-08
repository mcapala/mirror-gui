import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  BundlesFileMissingError,
  BundlesSchemaError,
  loadBundlesFile,
} from '../../server/bundlesLoader.js';

const FIXTURE_DIR = path.resolve(process.cwd(), 'tests/fixtures/catalog-data');

describe('loadBundlesFile', () => {
  it('loads a real M3 fixture bundles.json', async () => {
    const bundles = await loadBundlesFile(
      FIXTURE_DIR,
      'redhat-operator-index',
      'v4.21',
    );
    expect(bundles.schemaVersion).toBe(1);
    const acm = bundles.packages['advanced-cluster-management'];
    expect(acm).toBeDefined();
    const bundle = acm.bundles['advanced-cluster-management.v2.16.0'];
    expect(bundle.version).toBe('2.16.0');
    expect(bundle.image).toMatch(/@sha256:/);
    expect(Array.isArray(bundle.relatedImages)).toBe(true);
    expect(Object.keys(acm.channels).length).toBeGreaterThan(0);
  });

  it('includes bundles whose blobs live only in released-bundles.json', async () => {
    // Real indexes (e.g. quay-operator) reference channel entries whose
    // olm.bundle blobs sit in released-bundles.json, not catalog.json.
    const bundles = await loadBundlesFile(
      FIXTURE_DIR,
      'redhat-operator-index',
      'v4.21',
    );
    const acm = bundles.packages['advanced-cluster-management'];
    const released = acm.bundles['advanced-cluster-management.v2.16.1'];
    expect(released).toBeDefined();
    expect(released.version).toBe('2.16.1');
    expect(released.relatedImages).toEqual([
      'registry.redhat.io/rhacm2/acm-controller@sha256:c161000000000000000000000000000000000000000000000000000000000000',
    ]);
    // Inline catalog.json bundles must survive the merge.
    expect(acm.bundles['advanced-cluster-management.v2.16.0']).toBeDefined();
  });

  it('throws BundlesFileMissingError when the file is absent', async () => {
    await expect(
      loadBundlesFile(FIXTURE_DIR, 'redhat-operator-index', 'v9.99'),
    ).rejects.toBeInstanceOf(BundlesFileMissingError);
  });

  describe('schema gate', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bundles-'));
      await fs.promises.mkdir(path.join(dir, 'some-index', 'v1'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(dir, 'some-index', 'v1', 'bundles.json'),
        JSON.stringify({ schemaVersion: 99, packages: {} }),
      );
    });

    afterEach(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it('throws BundlesSchemaError on schemaVersion mismatch', async () => {
      await expect(
        loadBundlesFile(dir, 'some-index', 'v1'),
      ).rejects.toBeInstanceOf(BundlesSchemaError);
    });
  });

  describe('corrupt / malformed files', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'bundles-'));
    });

    afterEach(async () => {
      await fs.promises.rm(dir, { recursive: true, force: true });
    });

    it('throws BundlesSchemaError (not a raw SyntaxError) for non-JSON content', async () => {
      await fs.promises.mkdir(path.join(dir, 'some-index', 'v1'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(dir, 'some-index', 'v1', 'bundles.json'),
        '{ this is not json',
      );
      await expect(
        loadBundlesFile(dir, 'some-index', 'v1'),
      ).rejects.toBeInstanceOf(BundlesSchemaError);
    });

    it('throws BundlesSchemaError when schemaVersion is valid but packages is missing', async () => {
      await fs.promises.mkdir(path.join(dir, 'some-index', 'v1'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(dir, 'some-index', 'v1', 'bundles.json'),
        JSON.stringify({ schemaVersion: 1 }),
      );
      await expect(
        loadBundlesFile(dir, 'some-index', 'v1'),
      ).rejects.toBeInstanceOf(BundlesSchemaError);
    });
  });
});
