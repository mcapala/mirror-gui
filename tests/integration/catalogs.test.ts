import { describe, it, expect, beforeAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

describe('Catalogs API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  describe('GET /api/catalogs', () => {
    it('returns array of catalogs (fallback when no catalog-data)', async () => {
      const res = await request.get('/api/catalogs');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
      res.body.forEach((catalog: { name: string; url: string; description: string; operatorCount?: number }) => {
        expect(catalog).toHaveProperty('name');
        expect(catalog).toHaveProperty('url');
        expect(catalog).toHaveProperty('description');
        expect(typeof catalog.name).toBe('string');
        expect(typeof catalog.url).toBe('string');
      });
    });
  });
});
