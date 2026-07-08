import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createAcmRouter } from '../../server/acm/routes.js';
import { HubQueryError, type AcmHub } from '../../server/acm/types.js';
import type { HubQueryResult } from '../../server/acm/types.js';
import type { CatalogDataLike } from '../../server/acm/aggregate.js';

type FakeQueryHub = (
  hub: AcmHub,
  opts?: { limit?: number }
) => Promise<HubQueryResult>;

function makeApp(opts: {
  acmDir: string;
  queryHub?: FakeQueryHub;
  queryHubClusters?: (
    hub: AcmHub,
  ) => Promise<{ clusters: string[]; truncated: boolean }>;
  catalogData?: CatalogDataLike;
  loadCatalogData?: () => Promise<CatalogDataLike | null>;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/acm',
    createAcmRouter({
      acmDir: opts.acmDir,
      queryHub: (opts.queryHub ??
        (async () => ({
          csvItems: [],
          clusterItems: [],
          truncated: false,
        }))) as never,
      queryHubClusters: (opts.queryHubClusters ??
        (async () => ({ clusters: [], truncated: false }))) as never,
      loadCatalogData:
        opts.loadCatalogData ?? (async () => opts.catalogData ?? null),
      now: () => '2026-07-06T12:00:00.000Z',
    })
  );
  return app;
}

const HUB_INPUT = {
  name: 'prod',
  url: 'https://search.apps.hub.example.com',
  token: 'sha256~secret',
};

describe('ACM routes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'acm-routes-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  describe('hubs CRUD', () => {
    it('starts empty', async () => {
      const res = await request(makeApp({ acmDir: dir })).get('/api/acm/hubs');
      expect(res.status).toBe(200);
      expect(res.body.hubs).toEqual([]);
    });

    it('creates a hub and never returns the token', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      expect(created.status).toBe(201);
      expect(created.body.hub.hasToken).toBe(true);
      expect(JSON.stringify(created.body)).not.toContain('sha256~secret');

      const list = await request(app).get('/api/acm/hubs');
      expect(list.body.hubs).toHaveLength(1);
      expect(JSON.stringify(list.body)).not.toContain('sha256~secret');
    });

    it('rejects non-https URLs and missing fields', async () => {
      const app = makeApp({ acmDir: dir });
      const badUrl = await request(app)
        .post('/api/acm/hubs')
        .send({ ...HUB_INPUT, url: 'http://insecure.example.com' });
      expect(badUrl.status).toBe(400);
      expect(badUrl.body.error).toMatch(/https/);

      const noToken = await request(app)
        .post('/api/acm/hubs')
        .send({ name: 'x', url: 'https://h.example.com' });
      expect(noToken.status).toBe(400);
      expect(noToken.body.error).toMatch(/token/i);
    });

    it('keeps the stored token when update omits it', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const id = created.body.hub.id;

      const updated = await request(app)
        .put(`/api/acm/hubs/${id}`)
        .send({ name: 'prod-renamed', url: HUB_INPUT.url });
      expect(updated.status).toBe(200);
      expect(updated.body.hub.name).toBe('prod-renamed');
      expect(updated.body.hub.hasToken).toBe(true);

      const hubsOnDisk = JSON.parse(
        await fs.promises.readFile(path.join(dir, 'hubs.json'), 'utf8')
      );
      expect(hubsOnDisk[0].token).toBe('sha256~secret');
    });

    it('rejects creating a hub with a duplicate name', async () => {
      const app = makeApp({ acmDir: dir });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);

      const dup = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      expect(dup.status).toBe(400);
      expect(dup.body.error).toMatch(/already exists/);
    });

    it('rejects renaming a hub to another hub\'s name, but allows keeping its own name', async () => {
      const app = makeApp({ acmDir: dir });
      const hubA = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const hubB = await request(app)
        .post('/api/acm/hubs')
        .send({ ...HUB_INPUT, name: 'staging' });

      const renameToOther = await request(app)
        .put(`/api/acm/hubs/${hubB.body.hub.id}`)
        .send({ ...HUB_INPUT, name: 'prod' });
      expect(renameToOther.status).toBe(400);
      expect(renameToOther.body.error).toMatch(/already exists/);

      const keepOwnName = await request(app)
        .put(`/api/acm/hubs/${hubA.body.hub.id}`)
        .send(HUB_INPUT);
      expect(keepOwnName.status).toBe(200);
      expect(keepOwnName.body.hub.name).toBe('prod');
    });

    it('deletes a hub and 404s on unknown ids', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const id = created.body.hub.id;
      expect((await request(app).delete(`/api/acm/hubs/${id}`)).status).toBe(
        200
      );
      expect((await request(app).delete(`/api/acm/hubs/${id}`)).status).toBe(
        404
      );
      expect(
        (await request(app).put('/api/acm/hubs/nope').send(HUB_INPUT)).status
      ).toBe(404);
    });

    it('PUT returns 404 for an unknown hub even with an invalid body', async () => {
      const res = await request(makeApp({ acmDir: dir })).put('/api/acm/hubs/no-such-id').send({});
      expect(res.status).toBe(404);
    });

    it('PUT keeps the stored CA bundle when caBundle is omitted and clears it when empty string', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app).post('/api/acm/hubs').send({
        name: 'ca-hub', url: 'https://hub.example', token: 't', caBundle: 'PEM-DATA',
      });
      const id = created.body.hub.id;

      const kept = await request(app).put(`/api/acm/hubs/${id}`).send({
        name: 'ca-hub', url: 'https://hub.example',
      });
      expect(kept.body.hub.hasCaBundle).toBe(true);

      const cleared = await request(app).put(`/api/acm/hubs/${id}`).send({
        name: 'ca-hub', url: 'https://hub.example', caBundle: '',
      });
      expect(cleared.body.hub.hasCaBundle).toBe(false);
    });

    it('stores, redacts, dedupes and sorts the cluster selection', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app)
        .post('/api/acm/hubs')
        .send({ ...HUB_INPUT, clusters: ['zeta', 'alpha', 'zeta'] });
      expect(created.status).toBe(201);
      expect(created.body.hub.clusters).toEqual(['alpha', 'zeta']);

      const list = await request(app).get('/api/acm/hubs');
      expect(list.body.hubs[0].clusters).toEqual(['alpha', 'zeta']);
    });

    it('defaults clusters to [] when omitted on create', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      expect(created.body.hub.clusters).toEqual([]);
    });

    it('rejects a malformed clusters payload', async () => {
      const app = makeApp({ acmDir: dir });
      for (const clusters of ['c1', [1, 2], ['ok', '']]) {
        const res = await request(app)
          .post('/api/acm/hubs')
          .send({ ...HUB_INPUT, clusters });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/clusters must be an array/);
      }
    });

    it('PUT replaces, clears, or keeps the selection', async () => {
      const app = makeApp({ acmDir: dir });
      const created = await request(app)
        .post('/api/acm/hubs')
        .send({ ...HUB_INPUT, clusters: ['c1'] });
      const id = created.body.hub.id;

      const replaced = await request(app)
        .put(`/api/acm/hubs/${id}`)
        .send({ ...HUB_INPUT, clusters: ['c2', 'c1'] });
      expect(replaced.body.hub.clusters).toEqual(['c1', 'c2']);

      const kept = await request(app)
        .put(`/api/acm/hubs/${id}`)
        .send(HUB_INPUT);
      expect(kept.body.hub.clusters).toEqual(['c1', 'c2']);

      const cleared = await request(app)
        .put(`/api/acm/hubs/${id}`)
        .send({ ...HUB_INPUT, clusters: [] });
      expect(cleared.body.hub.clusters).toEqual([]);
    });
  });

  describe('POST /hubs/:id/test', () => {
    it('returns ok when the hub responds', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHub: async (_hub, opts) => {
          expect(opts?.limit).toBe(1);
          return { csvItems: [], clusterItems: [], truncated: false };
        },
      });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const res = await request(app).post(
        `/api/acm/hubs/${created.body.hub.id}/test`
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'ok' });
    });

    it('returns the distinguished failure kind', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHub: async () => {
          throw new HubQueryError('auth', 'authentication failed (HTTP 401)');
        },
      });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const res = await request(app).post(
        `/api/acm/hubs/${created.body.hub.id}/test`
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.kind).toBe('auth');
    });
  });

  describe('POST /hubs/:id/clusters/discover', () => {
    it('returns discovered cluster names without leaking the token', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHubClusters: async hub => {
          expect(hub.token).toBe('sha256~secret');
          return { clusters: ['alpha', 'zeta'], truncated: false };
        },
      });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const res = await request(app).post(
        `/api/acm/hubs/${created.body.hub.id}/clusters/discover`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        status: 'ok',
        clusters: ['alpha', 'zeta'],
        truncated: false,
      });
      expect(JSON.stringify(res.body)).not.toContain('sha256~secret');
    });

    it('passes hub failures through as status failed', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHubClusters: async () => {
          throw new HubQueryError('auth', 'authentication failed (HTTP 401)');
        },
      });
      const created = await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      const res = await request(app).post(
        `/api/acm/hubs/${created.body.hub.id}/clusters/discover`,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(res.body.kind).toBe('auth');
      expect(res.body.error).toMatch(/authentication failed/);
    });

    it('404s on an unknown hub id', async () => {
      const res = await request(makeApp({ acmDir: dir })).post(
        '/api/acm/hubs/no-such-id/clusters/discover',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('refresh and snapshot', () => {
    it('404s on snapshot before first refresh', async () => {
      const res = await request(makeApp({ acmDir: dir })).get(
        '/api/acm/snapshot'
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/never refreshed/i);
    });

    it('400s refresh when no hubs are configured', async () => {
      const res = await request(makeApp({ acmDir: dir })).post(
        '/api/acm/refresh'
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no ACM hubs/i);
    });

    it('builds, persists, and returns a snapshot; partial hub failure is flagged', async () => {
      const catalogData: CatalogDataLike = {
        operators: {
          'redhat-operator-index': [
            {
              name: 'acm',
              availableVersions: ['2.12.0'],
              catalog: 'redhat-operator-index',
            },
          ],
        },
      };
      const app = makeApp({
        acmDir: dir,
        catalogData,
        queryHub: async hub => {
          if (hub.name === 'down') {
            throw new HubQueryError('unreachable', 'hub unreachable — refused');
          }
          return {
            csvItems: [{ name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' }],
            clusterItems: [{ name: 'c1', openshiftVersion: '4.16.8' }],
            truncated: false,
          };
        },
      });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      await request(app)
        .post('/api/acm/hubs')
        .send({ ...HUB_INPUT, name: 'down' });

      const res = await request(app).post('/api/acm/refresh');
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(2);
      expect(res.body.refreshedAt).toBe('2026-07-06T12:00:00.000Z');
      expect(res.body.packages.acm.status).toBe('behind');
      const down = res.body.hubs.find(
        (h: { name: string }) => h.name === 'down'
      );
      expect(down.status).toBe('error');
      expect(JSON.stringify(res.body)).not.toContain('sha256~secret');

      const stored = await request(app).get('/api/acm/snapshot');
      expect(stored.status).toBe(200);
      expect(stored.body).toEqual(res.body);
      expect(JSON.stringify(stored.body)).not.toContain('sha256~secret');
    });

    it('degrades to unknown status when the catalog lookup totally fails', async () => {
      const app = makeApp({
        acmDir: dir,
        loadCatalogData: async () => {
          throw new Error('boom');
        },
        queryHub: async () => ({
          csvItems: [{ name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' }],
          clusterItems: [],
          truncated: false,
        }),
      });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);

      const res = await request(app).post('/api/acm/refresh');
      expect(res.status).toBe(200);
      expect(res.body.packages.acm.status).toBe('unknown');
    });

    it('refresh persists cluster versions in the snapshot', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHub: async () => ({
          csvItems: [{ name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' }],
          clusterItems: [{ name: 'c1', openshiftVersion: '4.16.8' }],
          truncated: false,
        }),
      });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);

      const res = await request(app).post('/api/acm/refresh');
      expect(res.status).toBe(200);
      expect(res.body.schemaVersion).toBe(2);
      expect(res.body.clusters).toEqual([
        expect.objectContaining({ cluster: 'c1', openshiftVersion: '4.16.8' }),
      ]);
    });

    it('409s a concurrent refresh', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const app = makeApp({
        acmDir: dir,
        queryHub: async () => {
          await gate;
          return { csvItems: [], clusterItems: [], truncated: false };
        },
      });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);

      const first = request(app).post('/api/acm/refresh');
      // supertest/superagent requests are dispatched lazily on the first
      // `.then()`/await, so trigger dispatch now instead of waiting until
      // `first` is awaited at the bottom of the test (otherwise `second`
      // would be the only request actually sent, and it would hang on the
      // gate forever).
      first.catch(() => {});
      // give the first request time to take the in-flight lock
      await new Promise(resolve => setTimeout(resolve, 50));
      const second = await request(app).post('/api/acm/refresh');
      expect(second.status).toBe(409);

      release();
      expect((await first).status).toBe(200);
    });

    it('GET /snapshot returns 422 when the stored snapshot has an unsupported schemaVersion', async () => {
      const app = makeApp({ acmDir: dir });
      await fs.promises.writeFile(
        path.join(dir, 'snapshot.json'),
        JSON.stringify({ schemaVersion: 999 }),
      );
      const res = await request(app).get('/api/acm/snapshot');
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/refresh/i);
    });
  });

  describe('POST /api/acm/suggest-update', () => {
    const VALID_ISC = {
      kind: 'ImageSetConfiguration',
      apiVersion: 'mirror.openshift.io/v2alpha1',
      mirror: {
        operators: [
          {
            catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
            packages: [
              {
                name: 'advanced-cluster-management',
                channels: [{ name: 'release-2.15' }],
              },
            ],
          },
        ],
      },
    };

    it('404s before the first refresh', async () => {
      const res = await request(makeApp({ acmDir: dir }))
        .post('/api/acm/suggest-update')
        .send({ config: VALID_ISC });
      expect(res.status).toBe(404);
    });

    it('422s on a body that is not an ISC', async () => {
      const res = await request(makeApp({ acmDir: dir }))
        .post('/api/acm/suggest-update')
        .send({ config: { kind: 'DeleteImageSetConfiguration' } });
      expect(res.status).toBe(422);
    });

    it('returns suggestions computed from the stored snapshot and catalog data', async () => {
      const catalogData: CatalogDataLike = {
        operators: {
          'redhat-operator-index:v4.21': [
            {
              name: 'advanced-cluster-management',
              defaultChannel: 'release-2.16',
              channelVersions: {
                'release-2.15': ['2.15.0', '2.15.1'],
                'release-2.16': ['2.16.0'],
              },
            },
          ],
        },
      };
      const app = makeApp({
        acmDir: dir,
        catalogData,
        queryHub: async () => ({
          csvItems: [
            {
              name: 'advanced-cluster-management.v2.15.0',
              cluster: 'c1',
              phase: 'Succeeded',
            },
          ],
          clusterItems: [{ name: 'c1', openshiftVersion: '4.16.8' }],
          truncated: false,
        }),
      });
      await request(app).post('/api/acm/hubs').send(HUB_INPUT);
      await request(app).post('/api/acm/refresh').expect(200);
      const res = await request(app)
        .post('/api/acm/suggest-update')
        .send({ config: VALID_ISC });
      expect(res.status).toBe(200);
      const kinds = res.body.suggestions.map((s: { kind: string }) => s.kind);
      expect(kinds).toContain('raise-min-version');
      expect(kinds).toContain('add-channel');
      expect(JSON.stringify(res.body)).not.toContain('sha256~secret');
    });

    it('422s when the stored snapshot has an incompatible schema', async () => {
      await fs.promises.writeFile(
        path.join(dir, 'snapshot.json'),
        JSON.stringify({ schemaVersion: 1 }),
      );
      const res = await request(makeApp({ acmDir: dir }))
        .post('/api/acm/suggest-update')
        .send({ config: VALID_ISC });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/refresh/i);
    });
  });
});
