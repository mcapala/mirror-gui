import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getTestApp } from './helpers/testApp.js';
import { ensureTestDirs } from './helpers/setup.js';

describe('Operations lifecycle API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;
  const seededOpId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  beforeAll(async () => {
    await ensureTestDirs();
    request = await getTestApp();

    const storageDir = process.env.STORAGE_DIR!;
    const operationsDir = path.join(storageDir, 'operations');
    const logsDir = path.join(storageDir, 'logs');

    const operationRecord = {
      id: seededOpId,
      name: `Mirror Operation ${seededOpId.slice(0, 8)}`,
      configFile: 'lifecycle-test-config.yaml',
      mirrorDestination: path.join(storageDir, 'mirrors', 'default'),
      status: 'success' as const,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      duration: 5,
      errorMessage: null,
      logs: ['line 1', 'line 2', '📌 images to copy 10', '✓ 3 / 3 operator images mirrored successfully'],
    };
    await fs.promises.writeFile(
      path.join(operationsDir, `${seededOpId}.json`),
      JSON.stringify(operationRecord, null, 2)
    );
    await fs.promises.writeFile(
      path.join(logsDir, `${seededOpId}.log`),
      operationRecord.logs.join('\n')
    );

    const fakeOcMirrorDir = path.join(os.tmpdir(), `oc-mirror-fake-${Date.now()}`);
    await fs.promises.mkdir(fakeOcMirrorDir, { recursive: true });
    const fakeScript = path.join(fakeOcMirrorDir, 'oc-mirror');
    await fs.promises.writeFile(fakeScript, '#!/bin/sh\nexit 0\n');
    await fs.promises.chmod(fakeScript, 0o755);
    const origPath = process.env.PATH || '';
    process.env.PATH = `${fakeOcMirrorDir}:${origPath}`;
  });

  describe('POST /api/operations/start success path', () => {
    it('starts operation and returns operationId', async () => {
      const configRes = await request.post('/api/config/save').send({
        config:
          'kind: ImageSetConfiguration\napiVersion: mirror.openshift.io/v2alpha1\nmirror:\n  platform: {}\n  operators: []\n  additionalImages: []',
        name: 'lifecycle-start-config.yaml',
      });
      expect(configRes.status).toBe(200);

      const res = await request.post('/api/operations/start').send({
        configFile: 'lifecycle-start-config.yaml',
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('success');
      expect(res.body.operationId).toBeDefined();
      expect(typeof res.body.operationId).toBe('string');
    });
  });

  describe('POST /api/operations/:id/stop', () => {
    it('returns success and updates operation to stopped', async () => {
      const res = await request.post(`/api/operations/${seededOpId}/stop`);
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('stopped');
    });
  });

  describe('GET /api/operations/:id/logs', () => {
    it('returns logs from file or operation record', async () => {
      const res = await request.get(`/api/operations/${seededOpId}/logs`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('logs');
      expect(typeof res.body.logs).toBe('string');
    });
  });

  describe('GET /api/operations/:id/details', () => {
    it('returns operation details with parsed metrics', async () => {
      const res = await request.get(`/api/operations/${seededOpId}/details`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        imagesMirrored: expect.any(Number),
        operatorsMirrored: expect.any(Number),
        totalSize: expect.any(Number),
        configFile: expect.any(String),
        manifestFiles: expect.any(Array),
      });
    });

    it('returns 404 for non-existent operation', async () => {
      const res = await request.get(
        '/api/operations/00000000-0000-0000-0000-000000000000/details'
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/operations/:id/logstream', () => {
    it('returns SSE stream with correct headers', async () => {
      const res = await request
        .get(`/api/operations/${seededOpId}/logstream`)
        .buffer(true)
        .parse((res, cb) => {
          let data = '';
          res.on('data', (chunk: Buffer) => {
            data += chunk.toString();
          });
          res.on('end', () => cb(null, data));
        });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
    });
  });
});
