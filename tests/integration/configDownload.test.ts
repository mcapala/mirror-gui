import { describe, it, expect, beforeAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

const validConfigYaml = `kind: ImageSetConfiguration
apiVersion: mirror.openshift.io/v2alpha1
mirror:
  platform:
    channels:
      - name: stable-4.21
        minVersion: "4.21.0"
        maxVersion: "4.21.4"
    graph: true
  operators: []
  additionalImages: []
`;

describe('Config download API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  describe('GET /api/config/download/:filename', () => {
    it('returns 400 for invalid extension (.txt)', async () => {
      const res = await request.get('/api/config/download/config.txt');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid filename/i);
    });

    it('returns 400 when decoded basename is not a yaml file (path traversal attempt)', async () => {
      const res = await request.get(
        `/api/config/download/${encodeURIComponent('../passwd')}`
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid filename/i);
    });

    it('returns 404 for non-existent yaml file', async () => {
      const res = await request.get(
        '/api/config/download/does-not-exist-9f3a2c1b.yaml'
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns file with yaml headers after save', async () => {
      const name = 'download-test-config.yaml';
      await request.post('/api/config/save').send({ config: validConfigYaml, name });

      const res = await request.get(`/api/config/download/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/yaml/i);
      expect(res.headers['content-disposition']).toContain('attachment');
      expect(res.headers['content-disposition']).toContain(name);
      expect(res.text).toContain('ImageSetConfiguration');

      await request.delete(`/api/config/delete/${name}`);
    });
  });
});
