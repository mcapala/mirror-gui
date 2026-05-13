import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

/** Dummy pull secret JSON only (no real credentials). */
const dummyPullSecret = () =>
  JSON.stringify({
    auths: {
      'registry.example.com': { auth: 'dXNlcjpwYXNz' },
    },
  });

describe('Pull Secret API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  afterAll(async () => {
    await request.post('/api/pull-secret').send({ content: dummyPullSecret() });
  });

  describe('GET /api/pull-secret/status', () => {
    it('returns detected boolean and path', async () => {
      const res = await request.get('/api/pull-secret/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('detected');
      expect(typeof res.body.detected).toBe('boolean');
      expect(res.body).toHaveProperty('path');
    });
  });

  describe('POST /api/pull-secret', () => {
    it('rejects empty content', async () => {
      const res = await request
        .post('/api/pull-secret')
        .send({ content: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('rejects non-JSON content', async () => {
      const res = await request
        .post('/api/pull-secret')
        .send({ content: 'not-json-content' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/valid JSON/i);
    });

    it('rejects missing content field', async () => {
      const res = await request
        .post('/api/pull-secret')
        .send({});
      expect(res.status).toBe(400);
    });

    it('accepts valid JSON pull secret', async () => {
      const validSecret = JSON.stringify({ auths: { 'registry.example.com': { auth: 'dXNlcjpwYXNz' } } });
      const res = await request
        .post('/api/pull-secret')
        .send({ content: validSecret });
      expect(res.status).toBe(200);
      expect(res.body.message).toMatch(/saved/i);
    });
  });

  describe('GET /api/system/status includes pullSecretDetected', () => {
    it('returns pullSecretDetected field', async () => {
      const res = await request.get('/api/system/status');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('pullSecretDetected');
      expect(typeof res.body.pullSecretDetected).toBe('boolean');
    });
  });

  describe('GET /api/system/info includes hostDataDir', () => {
    it('returns hostDataDir field', async () => {
      const res = await request.get('/api/system/info');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hostDataDir');
      expect(typeof res.body.hostDataDir).toBe('string');
      expect(res.body.hostDataDir.length).toBeGreaterThan(0);
    });
  });

  describe('GET /api/system/status systemHealth', () => {
    it('returns warning or other valid health when pull secret may not be detected', async () => {
      const res = await request.get('/api/system/status');
      expect(res.status).toBe(200);
      expect(['healthy', 'degraded', 'warning', 'error']).toContain(res.body.systemHealth);
    });
  });

  describe('GET /api/pull-secret/content', () => {
    it('returns saved content after POST', async () => {
      const content = dummyPullSecret();
      await request.post('/api/pull-secret').send({ content });
      const res = await request.get('/api/pull-secret/content');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('content');
      expect(res.body.content).toBe(content);
    });

    it('returns empty content when pull secret is not configured', async () => {
      await request.delete('/api/pull-secret');
      const res = await request.get('/api/pull-secret/content');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('content');
      expect(res.body.content).toBe('');
    });
  });

  describe('DELETE /api/pull-secret', () => {
    it('removes pull secret and status shows not detected', async () => {
      await request.post('/api/pull-secret').send({ content: dummyPullSecret() });
      const before = await request.get('/api/pull-secret/status');
      expect(before.status).toBe(200);
      expect(before.body.detected).toBe(true);

      const del = await request.delete('/api/pull-secret');
      expect(del.status).toBe(200);

      const after = await request.get('/api/pull-secret/status');
      expect(after.status).toBe(200);
      expect(after.body.detected).toBe(false);
      expect(after.body.path).toBeNull();

      const contentRes = await request.get('/api/pull-secret/content');
      expect(contentRes.body.content).toBe('');
    });
  });
});
