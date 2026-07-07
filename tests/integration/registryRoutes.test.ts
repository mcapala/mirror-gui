import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  createRegistryRouter,
  normalizePathPrefix,
  type RegistryRouterDeps,
} from '../../server/registry/routes.js';
import type { createRegistryClient } from '../../server/registry/client.js';
import type { IscConfig } from '../../server/acm/reconcile.js';

const FIXTURE_CATALOG_DIR = path.resolve(
  process.cwd(),
  'tests/fixtures/catalog-data',
);

const ISC: IscConfig = {
  kind: 'ImageSetConfiguration',
  apiVersion: 'mirror.openshift.io/v2alpha1',
  mirror: {
    operators: [
      { catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21' },
    ],
  },
};

const AUTHS = { 'quay.local:8443': { auth: 'dXNlcjpwYXNz' } };

type FakeClient = ReturnType<typeof createRegistryClient>;

function makeApp(overrides: Partial<RegistryRouterDeps> = {}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/mirror-registries',
    createRegistryRouter({
      storageDir: overrides.storageDir!,
      readPullSecretAuths: overrides.readPullSecretAuths ?? (async () => AUTHS),
      resolveCatalogDir:
        overrides.resolveCatalogDir ?? (async () => FIXTURE_CATALOG_DIR),
      listIscConfigs: overrides.listIscConfigs ?? (async () => [ISC]),
      createClient: overrides.createClient,
      now: () => '2026-07-07T12:00:00.000Z',
    }),
  );
  return app;
}

async function createRegistry(
  app: express.Express,
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await request(app)
    .post('/api/mirror-registries')
    .send({ host: 'quay.local:8443', pathPrefix: 'mirror', ...body });
  expect(res.status).toBe(201);
  return res.body.registry.id;
}

describe('normalizePathPrefix', () => {
  it('normalizes and validates', () => {
    expect(normalizePathPrefix(undefined)).toBe('');
    expect(normalizePathPrefix('')).toBe('');
    expect(normalizePathPrefix('/mirror/')).toBe('mirror');
    expect(normalizePathPrefix('mirror/prod')).toBe('mirror/prod');
    expect(normalizePathPrefix('bad prefix')).toBeNull();
    expect(normalizePathPrefix(42)).toBeNull();
  });
});

describe('mirror-registries routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'registry-routes-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  describe('CRUD', () => {
    it('starts empty and creates a registry', async () => {
      const app = makeApp({ storageDir: dir });
      const empty = await request(app).get('/api/mirror-registries');
      expect(empty.status).toBe(200);
      expect(empty.body.registries).toEqual([]);

      const id = await createRegistry(app);
      const list = await request(app).get('/api/mirror-registries');
      expect(list.body.registries).toHaveLength(1);
      expect(list.body.registries[0]).toMatchObject({
        id,
        host: 'quay.local:8443',
        pathPrefix: 'mirror',
        hasPullSecretAuth: true,
      });
    });

    it('rejects a host without pull-secret credentials', async () => {
      const app = makeApp({ storageDir: dir });
      const res = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'unknown.example', pathPrefix: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pull-secret/);
    });

    it('rejects duplicate host+prefix and invalid prefix', async () => {
      const app = makeApp({ storageDir: dir });
      await createRegistry(app);
      const dup = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'quay.local:8443', pathPrefix: '/mirror/' });
      expect(dup.status).toBe(400);
      expect(dup.body.error).toMatch(/already configured/);

      const bad = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'quay.local:8443', pathPrefix: 'has spaces' });
      expect(bad.status).toBe(400);
    });

    it('updates and deletes', async () => {
      const app = makeApp({ storageDir: dir });
      const id = await createRegistry(app);
      const updated = await request(app)
        .put(`/api/mirror-registries/${id}`)
        .send({ host: 'quay.local:8443', pathPrefix: 'other', insecureSkipVerify: true });
      expect(updated.status).toBe(200);
      expect(updated.body.registry.pathPrefix).toBe('other');
      expect(updated.body.registry.insecureSkipVerify).toBe(true);

      const gone = await request(app).delete(`/api/mirror-registries/${id}`);
      expect(gone.status).toBe(200);
      const list = await request(app).get('/api/mirror-registries');
      expect(list.body.registries).toEqual([]);
    });
  });

  describe('scan', () => {
    const fakeClient = (impl: {
      listTags: (repo: string) => Promise<string[] | null>;
      headManifest: (repo: string, tag: string) => Promise<string | null>;
      listRepositories?: () => Promise<string[] | null>;
    }) =>
      ((() => impl) as unknown) as typeof createRegistryClient;

    it('scans fixture-derived repos and persists the snapshot', async () => {
      // Digest of an actual bundle image in the redhat fixture bundles.json.
      const fixture = JSON.parse(
        await fs.promises.readFile(
          path.join(
            FIXTURE_CATALOG_DIR,
            'redhat-operator-index/v4.21/bundles.json',
          ),
          'utf8',
        ),
      );
      const acmBundle =
        fixture.packages['advanced-cluster-management'].bundles[
          'advanced-cluster-management.v2.16.0'
        ];
      const digest = acmBundle.image.split('@')[1];
      const repoPath = acmBundle.image.split('@')[0].split('/').slice(1).join('/');
      const mirroredRepo = `mirror/${repoPath}`;

      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async repo =>
            repo === mirroredRepo ? ['known-tag', 'drift-tag'] : null,
          headManifest: async (_repo, tag) =>
            tag === 'known-tag' ? digest : 'sha256:0000',
          listRepositories: async () => [],
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.schemaVersion).toBe(2);
      expect(scan.body.walkOk).toBe(true);
      expect(scan.body.scannedAt).toBe('2026-07-07T12:00:00.000Z');
      expect(scan.body.partial).toBe(false);
      expect(scan.body.catalogs).toEqual(['redhat-operator-index:v4.21']);
      expect(scan.body.stats.reposPresent).toBe(1);
      expect(scan.body.stats.matched).toBe(1);
      expect(scan.body.stats.unknown).toBe(1);

      const content = await request(app).get(
        `/api/mirror-registries/${id}/operator-content`,
      );
      expect(content.status).toBe(200);
      expect(
        content.body.packages['advanced-cluster-management'][0].version,
      ).toBe('2.16.0');
      expect(content.body.unknownTags).toEqual([
        { repo: mirroredRepo, tag: 'drift-tag', digest: 'sha256:0000' },
      ]);
    });

    it('409s a concurrent scan for the same registry', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async () => {
            await gate;
            return null;
          },
          headManifest: async () => null,
          listRepositories: async () => [],
        }),
      });
      const id = await createRegistry(app);
      // supertest requests are lazy — .then() starts it without awaiting completion.
      const first = request(app)
        .post(`/api/mirror-registries/${id}/scan`)
        .then(r => r);
      // Give the first scan a beat to acquire the in-flight slot.
      await new Promise(resolve => setTimeout(resolve, 50));
      const second = await request(app).post(
        `/api/mirror-registries/${id}/scan`,
      );
      expect(second.status).toBe(409);
      release();
      expect((await first).status).toBe(200);
    });

    it('400s when no ISC references an operator catalog', async () => {
      const app = makeApp({ storageDir: dir, listIscConfigs: async () => [] });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(400);
      expect(scan.body.error).toMatch(/no managed ImageSetConfigurations/);
    });

    it('records a catalog-data issue and continues when bundles.json is missing', async () => {
      const iscs: IscConfig[] = [
        ISC,
        {
          kind: 'ImageSetConfiguration',
          apiVersion: 'mirror.openshift.io/v2alpha1',
          mirror: {
            operators: [
              {
                catalog:
                  'registry.redhat.io/redhat/redhat-operator-index:v9.99',
              },
            ],
          },
        },
      ];
      const app = makeApp({
        storageDir: dir,
        listIscConfigs: async () => iscs,
        createClient: fakeClient({
          listTags: async () => null,
          headManifest: async () => null,
          listRepositories: async () => [],
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.partial).toBe(true);
      expect(scan.body.catalogs).toEqual(['redhat-operator-index:v4.21']);
      expect(scan.body.errors).toHaveLength(1);
      expect(scan.body.errors[0]).toMatchObject({
        catalog: 'redhat-operator-index:v9.99',
        kind: 'catalog-data',
      });
    });

    it('400s when every catalog fails to load', async () => {
      const app = makeApp({
        storageDir: dir,
        resolveCatalogDir: async () => path.join(dir, 'no-catalogs'),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(400);
      expect(scan.body.error).toMatch(/no bundle repos/);
      expect(scan.body.issues).toHaveLength(1);
    });
  });

  describe('operator-content', () => {
    it('404s before any scan and 422s on schema mismatch', async () => {
      const app = makeApp({ storageDir: dir });
      const id = await createRegistry(app);
      const never = await request(app).get(
        `/api/mirror-registries/${id}/operator-content`,
      );
      expect(never.status).toBe(404);
      expect(never.body.error).toBe('never scanned');

      await fs.promises.mkdir(path.join(dir, 'registry-scans'), {
        recursive: true,
      });
      await fs.promises.writeFile(
        path.join(dir, 'registry-scans', `${id}.json`),
        JSON.stringify({ schemaVersion: 99 }),
      );
      const stale = await request(app).get(
        `/api/mirror-registries/${id}/operator-content`,
      );
      expect(stale.status).toBe(422);
    });
  });
});
