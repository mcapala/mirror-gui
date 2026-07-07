import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { createRegistryClient } from '../../server/registry/client.js';
import { createRegistryRouter } from '../../server/registry/routes.js';
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
    additionalImages: [{ name: 'registry.redhat.io/ubi8/ubi:8.10' }],
  },
};

let registryServer: http.Server;
let registryHost: string;
let knownDigest: string;
let mirroredRepo: string;
let catalogWalkDisabled = false;

beforeAll(async () => {
  const fixture = JSON.parse(
    await fs.promises.readFile(
      path.join(
        FIXTURE_CATALOG_DIR,
        'redhat-operator-index/v4.21/bundles.json',
      ),
      'utf8',
    ),
  );
  const image =
    fixture.packages['advanced-cluster-management'].bundles[
      'advanced-cluster-management.v2.16.0'
    ].image;
  knownDigest = image.split('@')[1];
  mirroredRepo = `mirror/${image.split('@')[0].split('/').slice(1).join('/')}`;

  registryServer = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const auth = req.headers.authorization ?? '';

    // Token endpoint: exchange Basic for Bearer.
    if (url.pathname === '/token') {
      if (!auth.startsWith('Basic ')) {
        res.writeHead(401).end();
        return;
      }
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ token: 'stub-bearer-token' }));
      return;
    }

    // Everything under /v2/ requires the Bearer token.
    if (auth !== 'Bearer stub-bearer-token') {
      res
        .writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': `Bearer realm="http://${req.headers.host}/token",service="stub-registry"`,
        })
        .end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED' }] }));
      return;
    }

    // /v2/_catalog: two pages to exercise Link pagination.
    if (url.pathname === '/v2/_catalog') {
      if (catalogWalkDisabled) {
        res.writeHead(404).end(JSON.stringify({ errors: [] }));
        return;
      }
      if (!url.searchParams.has('last')) {
        res
          .writeHead(200, {
            'Content-Type': 'application/json',
            Link: `</v2/_catalog?last=x&n=100>; rel="next"`,
          })
          .end(JSON.stringify({ repositories: [mirroredRepo, 'mirror/ubi8/ubi'] }));
      } else {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ repositories: ['mirror/orphan/tool', 'outside/prefix'] }));
      }
      return;
    }

    const tagsMatch = url.pathname.match(/^\/v2\/(.+)\/tags\/list$/);
    if (tagsMatch) {
      if (tagsMatch[1] === 'mirror/ubi8/ubi') {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ name: tagsMatch[1], tags: ['8.10', '8.9'] }));
        return;
      }
      if (tagsMatch[1] === 'mirror/orphan/tool') {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ name: tagsMatch[1], tags: ['v1'] }));
        return;
      }
      if (tagsMatch[1] !== mirroredRepo) {
        res.writeHead(404).end(JSON.stringify({ errors: [] }));
        return;
      }
      // Two pages to exercise Link pagination.
      if (!url.searchParams.has('last')) {
        res
          .writeHead(200, {
            'Content-Type': 'application/json',
            Link: `</v2/${mirroredRepo}/tags/list?last=known-tag&n=100>; rel="next"`,
          })
          .end(JSON.stringify({ name: tagsMatch[1], tags: ['known-tag'] }));
      } else {
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ name: tagsMatch[1], tags: ['drift-tag'] }));
      }
      return;
    }

    const manifestMatch = url.pathname.match(/^\/v2\/(.+)\/manifests\/(.+)$/);
    if (manifestMatch && req.method === 'HEAD') {
      const digest =
        manifestMatch[2] === 'known-tag' ? knownDigest : 'sha256:feedface';
      res
        .writeHead(200, {
          'Content-Type':
            'application/vnd.docker.distribution.manifest.list.v2+json',
          'Docker-Content-Digest': digest,
        })
        .end();
      return;
    }

    res.writeHead(404).end();
  });
  await new Promise<void>(resolve =>
    registryServer.listen(0, '127.0.0.1', () => resolve()),
  );
  const address = registryServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  registryHost = `127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise(resolve => registryServer.close(resolve));
});

describe('registry scan against a live stub registry', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'registry-e2e-'));
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
    catalogWalkDisabled = false;
  });

  it('runs the full scan flow: token auth, pagination, digest join', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/mirror-registries',
      createRegistryRouter({
        storageDir: dir,
        readPullSecretAuths: async () => ({
          [registryHost]: { auth: Buffer.from('user:pass').toString('base64') },
        }),
        resolveCatalogDir: async () => FIXTURE_CATALOG_DIR,
        listIscConfigs: async () => [ISC],
        // The stub registry is plain HTTP; production default stays https.
        createClient: opts => createRegistryClient({ ...opts, scheme: 'http' }),
        now: () => '2026-07-07T12:00:00.000Z',
      }),
    );

    const created = await request(app)
      .post('/api/mirror-registries')
      .send({ host: registryHost, pathPrefix: 'mirror' });
    expect(created.status).toBe(201);
    const id = created.body.registry.id;

    const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.body.schemaVersion).toBe(2);
    expect(scan.body.walkOk).toBe(true);
    const byRepo = Object.fromEntries(
      scan.body.repos.map((r: { repo: string }) => [r.repo, r]),
    );
    expect(byRepo[mirroredRepo].origin).toBe('operator');
    const ubi = byRepo['mirror/ubi8/ubi'];
    expect(ubi.origin).toBe('additional');
    expect(ubi.sourceHost).toBe('registry.redhat.io');
    expect(
      ubi.tags.find((t: { tag: string }) => t.tag === '8.10').matchedAdditional,
    ).toBe('registry.redhat.io/ubi8/ubi:8.10');
    expect(
      ubi.tags.find((t: { tag: string }) => t.tag === '8.9').matchedAdditional,
    ).toBeNull();
    expect(byRepo['mirror/orphan/tool'].origin).toBe('walk');
    expect(byRepo['outside/prefix']).toBeUndefined();
    expect(scan.body.stats.reposWalked).toBe(1);
    expect(scan.body.stats.reposAdditional).toBe(1);
    expect(scan.body.partial).toBe(false);
    expect(scan.body.stats.reposPresent).toBe(1);
    expect(scan.body.stats.tagsScanned).toBe(5);
    expect(scan.body.stats.matched).toBe(2);
    expect(scan.body.stats.unknown).toBe(3);

    const content = await request(app).get(
      `/api/mirror-registries/${id}/operator-content`,
    );
    expect(content.status).toBe(200);
    expect(
      content.body.packages['advanced-cluster-management'][0],
    ).toMatchObject({ version: '2.16.0', tag: 'known-tag' });
    expect(content.body.unknownTags).toEqual([
      { repo: mirroredRepo, tag: 'drift-tag', digest: 'sha256:feedface' },
    ]);
  });

  it('records walkOk=false and keeps scanning when _catalog is unsupported', async () => {
    const app = express();
    app.use(express.json());
    app.use(
      '/api/mirror-registries',
      createRegistryRouter({
        storageDir: dir,
        readPullSecretAuths: async () => ({
          [registryHost]: { auth: Buffer.from('user:pass').toString('base64') },
        }),
        resolveCatalogDir: async () => FIXTURE_CATALOG_DIR,
        listIscConfigs: async () => [ISC],
        createClient: opts => createRegistryClient({ ...opts, scheme: 'http' }),
        now: () => '2026-07-07T12:00:00.000Z',
      }),
    );

    const created = await request(app)
      .post('/api/mirror-registries')
      .send({ host: registryHost, pathPrefix: 'mirror' });
    expect(created.status).toBe(201);
    const id = created.body.registry.id;

    catalogWalkDisabled = true;
    const scan = await request(app).post(`/api/mirror-registries/${id}/scan`);
    expect(scan.status).toBe(200);
    expect(scan.body.walkOk).toBe(false);
    expect(scan.body.partial).toBe(true);
    expect(
      scan.body.errors.some((e: { message: string }) =>
        e.message.includes('_catalog'),
      ),
    ).toBe(true);
    expect(
      scan.body.repos.some((r: { origin: string }) => r.origin === 'walk'),
    ).toBe(false);
  });
});
