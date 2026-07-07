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
});
