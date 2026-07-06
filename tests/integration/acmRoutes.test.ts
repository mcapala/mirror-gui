import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createAcmRouter } from '../../server/acm/routes.js';
import {
  HubQueryError,
  type AcmHub,
  type CatalogLookup,
} from '../../server/acm/types.js';
import type { HubQueryResult } from '../../server/acm/types.js';

type FakeQueryHub = (
  hub: AcmHub,
  opts?: { limit?: number }
) => Promise<HubQueryResult>;

function makeApp(opts: {
  acmDir: string;
  queryHub?: FakeQueryHub;
  catalog?: CatalogLookup;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/acm',
    createAcmRouter({
      acmDir: opts.acmDir,
      queryHub: (opts.queryHub ??
        (async () => ({ items: [], truncated: false }))) as never,
      loadCatalogLookup: async () => opts.catalog ?? new Map(),
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
  });

  describe('POST /hubs/:id/test', () => {
    it('returns ok when the hub responds', async () => {
      const app = makeApp({
        acmDir: dir,
        queryHub: async (_hub, opts) => {
          expect(opts?.limit).toBe(1);
          return { items: [], truncated: false };
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
      const catalog: CatalogLookup = new Map([
        [
          'acm',
          { latestAvailable: '2.12.0', catalogSource: 'redhat-operator-index' },
        ],
      ]);
      const app = makeApp({
        acmDir: dir,
        catalog,
        queryHub: async hub => {
          if (hub.name === 'down') {
            throw new HubQueryError('unreachable', 'hub unreachable — refused');
          }
          return {
            items: [{ name: 'acm.v2.10.3', cluster: 'c1', phase: 'Succeeded' }],
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
      expect(res.body.schemaVersion).toBe(1);
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

    it('409s a concurrent refresh', async () => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const app = makeApp({
        acmDir: dir,
        queryHub: async () => {
          await gate;
          return { items: [], truncated: false };
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
  });
});
