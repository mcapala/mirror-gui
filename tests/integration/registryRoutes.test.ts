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
import { RegistryRequestError } from '../../server/registry/types.js';
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
      readAcmSnapshot: overrides.readAcmSnapshot ?? (async () => null),
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

    it('accepts a host without pull-secret credentials (anonymous or local creds)', async () => {
      const app = makeApp({ storageDir: dir });
      const res = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'internal.example:5000', pathPrefix: '' });
      expect(res.status).toBe(201);
      expect(res.body.registry).toMatchObject({
        host: 'internal.example:5000',
        hasCredentials: false,
        hasPullSecretAuth: false,
      });
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

  describe('stored credentials', () => {
    it('stores username/password, never returns password, sets hasCredentials', async () => {
      const app = makeApp({ storageDir: dir });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({
          host: 'internal.example:5000',
          pathPrefix: 'mirror',
          username: 'svc',
          password: 'hunter2',
        });
      expect(created.status).toBe(201);
      expect(created.body.registry.hasCredentials).toBe(true);
      expect(created.body.registry.username).toBe('svc');
      expect(created.body.registry).not.toHaveProperty('password');
      expect(JSON.stringify(created.body)).not.toContain('hunter2');

      const list = await request(app).get('/api/mirror-registries');
      expect(list.body.registries[0].hasCredentials).toBe(true);
      expect(JSON.stringify(list.body)).not.toContain('hunter2');

      // password persisted on disk (store file), just not serialized
      const raw = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'registries.json'), 'utf8'),
      );
      expect(raw.registries[0].password).toBe('hunter2');
      // ...and the store file is owner-only, like the ACM hub token store.
      const stat = await fs.promises.stat(path.join(dir, 'registries.json'));
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it('rejects a PUT password without a username', async () => {
      const app = makeApp({ storageDir: dir });
      const id = await createRegistry(app);
      const res = await request(app)
        .put(`/api/mirror-registries/${id}`)
        .send({ host: 'quay.local:8443', pathPrefix: 'mirror', password: 'p' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/together/);
    });

    it('rejects half-set credentials on create', async () => {
      const app = makeApp({ storageDir: dir });
      const res = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'internal.example:5000', pathPrefix: '', username: 'svc' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/together/);
    });

    it('PUT keeps the stored password when the field is absent', async () => {
      const app = makeApp({ storageDir: dir });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({
          host: 'internal.example:5000',
          pathPrefix: 'mirror',
          username: 'svc',
          password: 'hunter2',
        });
      const id = created.body.registry.id;
      const updated = await request(app)
        .put(`/api/mirror-registries/${id}`)
        .send({ host: 'internal.example:5000', pathPrefix: 'prod', username: 'svc' });
      expect(updated.status).toBe(200);
      expect(updated.body.registry.hasCredentials).toBe(true);
      const raw = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'registries.json'), 'utf8'),
      );
      expect(raw.registries[0].password).toBe('hunter2');
      expect(raw.registries[0].pathPrefix).toBe('prod');
    });

    it('PUT with empty password (or absent username) clears credentials', async () => {
      const app = makeApp({ storageDir: dir });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({
          host: 'internal.example:5000',
          pathPrefix: 'mirror',
          username: 'svc',
          password: 'hunter2',
        });
      const id = created.body.registry.id;
      const cleared = await request(app)
        .put(`/api/mirror-registries/${id}`)
        .send({
          host: 'internal.example:5000',
          pathPrefix: 'mirror',
          username: 'svc',
          password: '',
        });
      expect(cleared.status).toBe(200);
      expect(cleared.body.registry.hasCredentials).toBe(false);
      const raw = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'registries.json'), 'utf8'),
      );
      expect(raw.registries[0]).not.toHaveProperty('password');
      expect(raw.registries[0]).not.toHaveProperty('username');
    });

    it('PUT requires a password when setting credentials on a registry without any', async () => {
      const app = makeApp({ storageDir: dir });
      const id = await createRegistry(app);
      const res = await request(app)
        .put(`/api/mirror-registries/${id}`)
        .send({ host: 'quay.local:8443', pathPrefix: 'mirror', username: 'svc' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/password is required/);
    });
  });

  describe('POST /:id/verify', () => {
    let lastClientOpts: { basicAuth: string | null } | undefined;

    function fakeClientForPing(ping: () => Promise<void>) {
      return ((opts: { basicAuth: string | null }) => {
        lastClientOpts = opts;
        return {
          listTags: async () => null,
          headManifest: async () => null,
          listRepositories: async () => null,
          ping,
        };
      }) as unknown as typeof createRegistryClient;
    }

    it('404s on unknown id', async () => {
      const app = makeApp({ storageDir: dir });
      const res = await request(app)
        .post('/api/mirror-registries/nope/verify')
        .send();
      expect(res.status).toBe(404);
    });

    it('ok:true with source local, using stored credentials', async () => {
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClientForPing(async () => {}),
      });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({
          host: 'internal.example:5000',
          pathPrefix: '',
          username: 'svc',
          password: 'hunter2',
        });
      const res = await request(app)
        .post(`/api/mirror-registries/${created.body.registry.id}/verify`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, source: 'local' });
      expect(lastClientOpts!.basicAuth).toBe(
        Buffer.from('svc:hunter2').toString('base64'),
      );
    });

    it('ok:false carries kind and message, source pull-secret; no secrets leak', async () => {
      const { RegistryRequestError } = await import(
        '../../server/registry/types.js'
      );
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClientForPing(async () => {
          throw new RegistryRequestError('auth', 'authentication failed (HTTP 401)');
        }),
      });
      const id = await createRegistry(app); // quay.local:8443 — in AUTHS
      const res = await request(app)
        .post(`/api/mirror-registries/${id}/verify`)
        .send();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: false,
        source: 'pull-secret',
        kind: 'auth',
      });
      expect(JSON.stringify(res.body)).not.toContain('dXNlcjpwYXNz');
    });

    it('source none when nothing resolves (anonymous probe)', async () => {
      const app = makeApp({
        storageDir: dir,
        readPullSecretAuths: async () => null,
        createClient: fakeClientForPing(async () => {}),
      });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({ host: 'internal.example:5000', pathPrefix: '' });
      const res = await request(app)
        .post(`/api/mirror-registries/${created.body.registry.id}/verify`)
        .send();
      expect(res.body).toEqual({ ok: true, source: 'none' });
      expect(lastClientOpts!.basicAuth).toBeNull();
    });
  });

  describe('scan', () => {
    const fakeClient = (impl: {
      listTags: (repo: string) => Promise<string[] | null>;
      headManifest: (repo: string, tag: string) => Promise<string | null>;
      listRepositories?: () => Promise<string[] | null>;
      ping?: () => Promise<void>;
    }) =>
      ((() => ({ ping: async () => {}, ...impl })) as unknown) as typeof createRegistryClient;

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
          listRepositories: async () => [mirroredRepo],
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
          listTags: async () => null,
          headManifest: async () => null,
          listRepositories: async () => {
            await gate;
            return [];
          },
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

    it('treats an auth-denied _catalog walk as walk-unsupported, not a scan error', async () => {
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async () => null,
          headManifest: async () => null,
          listRepositories: async () => {
            throw new RegistryRequestError(
              'auth',
              'token exchange failed (HTTP 400) for _catalog — check the pull secret entry',
            );
          },
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.walkOk).toBe(false);
      expect(scan.body.partial).toBe(false);
      expect(scan.body.errors).toEqual([]);
    });

    it('keeps a transport-level _catalog walk failure as a scan error', async () => {
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async () => null,
          headManifest: async () => null,
          listRepositories: async () => {
            throw new RegistryRequestError(
              'unreachable',
              'registry unreachable — ECONNRESET',
            );
          },
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.walkOk).toBe(false);
      expect(scan.body.partial).toBe(true);
      expect(scan.body.errors).toHaveLength(1);
      expect(scan.body.errors[0]).toMatchObject({
        kind: 'unreachable',
        repo: null,
      });
      expect(scan.body.errors[0].message).toMatch(/_catalog walk failed/);
    });

    it('does not probe expected repos the successful walk did not list', async () => {
      const probed: string[] = [];
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async repo => {
            probed.push(repo);
            return null;
          },
          headManifest: async () => null,
          listRepositories: async () => ['mirror/present/only'],
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.walkOk).toBe(true);
      expect(probed).toEqual(['mirror/present/only']);
      // Expected repos still appear in the snapshot, absent.
      expect(scan.body.stats.reposExpected).toBeGreaterThan(0);
      expect(
        scan.body.repos
          .filter((r: { origin: string }) => r.origin === 'operator')
          .every((r: { present: boolean }) => r.present === false),
      ).toBe(true);
    });

    it('classifies walked catalog-index repos as support, not additional', async () => {
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async repo =>
            repo === 'mirror/redhat/redhat-operator-index' ? ['v4.21'] : null,
          headManifest: async () => 'sha256:idx',
          listRepositories: async () => ['mirror/redhat/redhat-operator-index'],
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(200);
      expect(scan.body.stats.reposSupport).toBe(1);
      const indexRepo = scan.body.repos.find(
        (r: { repo: string }) => r.repo === 'mirror/redhat/redhat-operator-index',
      );
      expect(indexRepo.origin).toBe('support');

      const content = await request(app).get(
        `/api/mirror-registries/${id}/operator-content`,
      );
      expect(content.body.supportImages).toEqual([
        { repo: 'mirror/redhat/redhat-operator-index', tag: 'v4.21', digest: 'sha256:idx' },
      ]);
      expect(content.body.additionalImages).toEqual([]);
    });

    it('scans with stored credentials when the pull secret has none', async () => {
      let capturedBasicAuth: string | null | undefined;
      const app = makeApp({
        storageDir: dir,
        readPullSecretAuths: async () => null,
        createClient: ((opts: { basicAuth: string | null }) => {
          capturedBasicAuth = opts.basicAuth;
          return {
            listTags: async () => null,
            headManifest: async () => null,
            listRepositories: async () => [],
            ping: async () => {},
          };
        }) as unknown as typeof createRegistryClient,
      });
      const created = await request(app)
        .post('/api/mirror-registries')
        .send({
          host: 'internal.example:5000',
          pathPrefix: 'mirror',
          username: 'svc',
          password: 'hunter2',
        });
      const scan = await request(app).post(
        `/api/mirror-registries/${created.body.registry.id}/scan`,
      );
      expect(scan.status).toBe(200);
      expect(capturedBasicAuth).toBe(
        Buffer.from('svc:hunter2').toString('base64'),
      );
    });

    it('502s the scan when the registry auth probe fails', async () => {
      const app = makeApp({
        storageDir: dir,
        createClient: fakeClient({
          listTags: async () => null,
          headManifest: async () => null,
          ping: async () => {
            throw new RegistryRequestError(
              'auth',
              'authentication failed (HTTP 401) — check the credentials',
            );
          },
        }),
      });
      const id = await createRegistry(app);
      const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
      expect(scan.status).toBe(502);
      expect(scan.body.kind).toBe('auth');
      expect(scan.body.error).toMatch(/registry probe failed/);
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
