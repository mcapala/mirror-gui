import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import {
  createRegistryRouter,
  type RegistryRouterDeps,
} from '../../server/registry/routes.js';
import type { createRegistryClient } from '../../server/registry/client.js';
import type { IscConfig } from '../../server/acm/reconcile.js';
import type { DeployedOperatorSnapshot } from '../../server/acm/types.js';

type FakeClient = ReturnType<typeof createRegistryClient>;

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

function acmOk(over: Partial<DeployedOperatorSnapshot> = {}): DeployedOperatorSnapshot {
  return {
    schemaVersion: 2,
    refreshedAt: '2026-07-07T09:00:00.000Z',
    hubs: [
      {
        id: 'h1',
        name: 'hub1',
        status: 'ok',
        error: null,
        truncated: false,
        skippedItems: 0,
        clusterCount: 2,
      },
    ],
    clusters: [],
    packages: {},
    ...over,
  };
}

function makeApp(
  storageDir: string,
  readAcmSnapshot: () => Promise<DeployedOperatorSnapshot | null>,
) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/mirror-registries',
    createRegistryRouter({
      storageDir,
      readPullSecretAuths: async () => AUTHS,
      resolveCatalogDir: async () => storageDir,
      listIscConfigs: async () => [ISC],
      readAcmSnapshot,
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

describe('POST /api/mirror-registries/:id/generate-disc', () => {
  let dir: string;
  let registryId: string;
  let unscannedId: string;
  let staleId: string;
  let app: express.Express;
  let strictApp: express.Express;

  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'registry-disc-'));

    // Create catalog data directory with fixture content
    const catalogDir = path.join(dir, 'redhat-operator-index/v4.21');
    await fs.promises.mkdir(catalogDir, { recursive: true });

    const bundlesContent = {
      schemaVersion: 1,
      packages: {
        'advanced-cluster-management': {
          bundles: {
            'advanced-cluster-management.v2.16.0': {
              version: '2.16.0',
              image:
                'registry.redhat.io/rhacm2/acm-operator-bundle@sha256:2160000000000000000000000000000000000000000000000000000000000000',
              relatedImages: [
                'registry.redhat.io/rhacm2/acm-controller@sha256:c160000000000000000000000000000000000000000000000000000000000000',
              ],
            },
          },
          channels: {
            'release-2.16': [
              {
                name: 'advanced-cluster-management.v2.16.0',
              },
            ],
          },
        },
      },
    };

    await fs.promises.writeFile(
      path.join(catalogDir, 'bundles.json'),
      JSON.stringify(bundlesContent, null, 2),
    );

    // Create a walk repo (for orphan testing)
    const walkRepoPath = path.join(dir, 'mirror/legacy/tool');
    await fs.promises.mkdir(walkRepoPath, { recursive: true });

    app = makeApp(dir, async () => acmOk());
    strictApp = makeApp(dir, async () => null);

    // Create main registry with scan
    registryId = await createRegistry(app, { pathPrefix: 'mirror-scanned' });

    // Create unscanned registry
    unscannedId = await createRegistry(app, { pathPrefix: 'mirror-unscanned' });

    // Create registry with v1 snapshot
    staleId = await createRegistry(app, { pathPrefix: 'mirror-stale' });
    const scansDir = path.join(dir, 'registry-scans');
    await fs.promises.mkdir(scansDir, { recursive: true });
    await fs.promises.writeFile(
      path.join(scansDir, `${staleId}.json`),
      JSON.stringify({ schemaVersion: 1 }),
    );

    // Write scan snapshot for main registry
    const snapshot = {
      schemaVersion: 2,
      registryId,
      host: 'quay.local:8443',
      pathPrefix: 'mirror',
      scannedAt: '2026-07-07T12:00:00.000Z',
      partial: false,
      walkOk: true,
      catalogs: ['redhat-operator-index:v4.21'],
      repos: [
        {
          repo: 'mirror/rhacm2/acm-operator-bundle',
          present: true,
          origin: 'operator',
          sourceHost: null,
          hostAmbiguous: false,
          tags: [
            {
              tag: 'v2.16.0',
              digest:
                'sha256:2160000000000000000000000000000000000000000000000000000000000000',
              matched: {
                package: 'advanced-cluster-management',
                bundleName: 'advanced-cluster-management.v2.16.0',
                version: '2.16.0',
                catalog: 'redhat-operator-index:v4.21',
              },
              matchedAdditional: null,
            },
          ],
        },
        {
          repo: 'mirror/legacy/tool',
          present: true,
          origin: 'walk',
          sourceHost: 'quay.io',
          hostAmbiguous: false,
          tags: [
            {
              tag: 'v1',
              digest:
                'sha256:1111111111111111111111111111111111111111111111111111111111111111',
              matched: null,
              matchedAdditional: {
                sourceRef: 'quay.io/legacy/tool:v1',
              },
            },
          ],
        },
      ],
      errors: [],
      stats: {
        reposExpected: 1,
        reposPresent: 1,
        tagsScanned: 1,
        matched: 1,
        unknown: 0,
        reposAdditional: 1,
        reposWalked: 1,
      },
    };

    await fs.promises.writeFile(
      path.join(scansDir, `${registryId}.json`),
      JSON.stringify(snapshot),
    );
  });

  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('404s on an unknown registry', async () => {
    const res = await request(app)
      .post('/api/mirror-registries/nope/generate-disc')
      .send({});
    expect(res.status).toBe(404);
  });

  it('404s when never scanned', async () => {
    const res = await request(app)
      .post(`/api/mirror-registries/${unscannedId}/generate-disc`)
      .send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('never scanned');
  });

  it('422s on a v1 snapshot', async () => {
    const res = await request(app)
      .post(`/api/mirror-registries/${staleId}/generate-disc`)
      .send({});
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('scan again');
  });

  it('400s on malformed bodies', async () => {
    for (const body of [
      { strict: 'yes' },
      { includeAdditionalImages: 1 },
      { includeOrphans: 'x' },
      { includeOrphans: [{ repo: 'a' }] },
    ]) {
      const res = await request(app)
        .post(`/api/mirror-registries/${registryId}/generate-disc`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it('returns DISC YAML + report on the happy path', async () => {
    const res = await request(app)
      .post(`/api/mirror-registries/${registryId}/generate-disc`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.discYaml).toContain('DeleteImageSetConfiguration');
    expect(res.body.report.operators.candidates).toHaveLength(1);
    expect(res.body.report.acmRefreshedAt).toBe('2026-07-07T09:00:00.000Z');
  });

  it('422s with the report in strict mode when the fleet gate holds items', async () => {
    const res = await request(strictApp)
      .post(`/api/mirror-registries/${registryId}/generate-disc`)
      .send({ strict: true });
    expect(res.status).toBe(422);
    expect(res.body.report.operators.held[0].reason).toBe('acm-unverifiable');
  });

  it('re-validates orphan picks round-trip', async () => {
    const res = await request(app)
      .post(`/api/mirror-registries/${registryId}/generate-disc`)
      .send({
        includeOrphans: [
          {
            repo: 'mirror/legacy/tool',
            tag: 'v1',
            sourceRef: 'quay.io/legacy/tool:v1',
          },
          { repo: 'mirror/absent', tag: 'x', sourceRef: 'quay.io/absent:x' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.discYaml).toContain('quay.io/legacy/tool:v1');
    expect(res.body.report.additionalImages.rejectedPicks).toHaveLength(1);
  });
});
