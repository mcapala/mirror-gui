import { describe, it, expect, beforeAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

describe('Operators API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  describe('GET /api/operators', () => {
    it('returns array (empty or fallback when no catalog-data)', async () => {
      const res = await request.get('/api/operators');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('accepts catalog query parameter', async () => {
      const res = await request.get('/api/operators').query({
        catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('accepts detailed query parameter', async () => {
      const res = await request.get('/api/operators').query({
        catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
        detailed: 'true',
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('POST /api/operators/refresh-cache', () => {
    it('returns success', async () => {
      const res = await request.post('/api/operators/refresh-cache');
      expect(res.status).toBe(200);
      expect(res.body.message).toContain('refreshed');
    });
  });

  describe('GET /api/operators/:operator/versions', () => {
    it('returns 404 when operator not found (no catalog-data)', async () => {
      const res = await request.get('/api/operators/nonexistent-operator-xyz/versions');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });

    it('accepts catalog and channel query parameters', async () => {
      const res = await request
        .get('/api/operators/some-operator/versions')
        .query({ catalog: 'registry.redhat.io/redhat/redhat-operator-index:v4.21', channel: 'stable' });
      expect([404, 200]).toContain(res.status);
      if (res.status === 200) {
        expect(res.body).toHaveProperty('versions');
        expect(Array.isArray(res.body.versions)).toBe(true);
      }
    });
  });

  describe('GET /api/operator-channels/:operator', () => {
    it('returns 404 when operator not found (no catalog-data)', async () => {
      const res = await request.get('/api/operator-channels/nonexistent-operator-xyz');
      expect(res.status).toBe(404);
      expect(res.body.error).toBeDefined();
    });
  });

  describe('GET /api/operators/channels', () => {
    it('returns 400 when catalogUrl and operatorName are missing', async () => {
      const res = await request.get('/api/operators/channels');
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('required');
    });

    it('returns 400 when only catalogUrl is provided', async () => {
      const res = await request.get('/api/operators/channels').query({
        catalogUrl: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
      });
      expect(res.status).toBe(400);
    });

    it('returns 400 when only operatorName is provided', async () => {
      const res = await request.get('/api/operators/channels').query({
        operatorName: 'some-operator',
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 or 200 when both params provided (no catalog-data)', async () => {
      const res = await request.get('/api/operators/channels').query({
        catalogUrl: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
        operatorName: 'some-operator',
      });
      expect([200, 404]).toContain(res.status);
      if (res.status === 200) {
        expect(Array.isArray(res.body) || typeof res.body === 'object').toBe(true);
      }
    });
  });

  describe('GET /api/operators/:operator/dependencies', () => {
    it('returns 200 with dependencies structure', async () => {
      const res = await request.get('/api/operators/some-operator/dependencies');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('operator');
      expect(res.body).toHaveProperty('dependencies');
      expect(Array.isArray(res.body.dependencies)).toBe(true);
    });

    it('returns empty dependencies when none found (no catalog-data)', async () => {
      const res = await request.get('/api/operators/nonexistent-operator-xyz/dependencies');
      expect(res.status).toBe(200);
      expect(res.body.operator).toBe('nonexistent-operator-xyz');
      expect(res.body.dependencies).toEqual([]);
      expect(res.body.message).toContain('No dependencies');
    });

    it('accepts catalogUrl query parameter', async () => {
      const res = await request.get('/api/operators/some-operator/dependencies').query({
        catalogUrl: 'registry.redhat.io/redhat/redhat-operator-index:v4.21',
      });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('dependencies');
    });
  });
});
