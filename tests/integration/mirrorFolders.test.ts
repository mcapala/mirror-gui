import { describe, it, expect, beforeAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

describe('Mirror folders API', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  describe('GET /api/mirror-folders', () => {
    it('returns a folders array', async () => {
      const res = await request.get('/api/mirror-folders');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('folders');
      expect(Array.isArray(res.body.folders)).toBe(true);
    });
  });

  describe('POST /api/mirror-folders', () => {
    it('rejects invalid folder name (special characters)', async () => {
      const res = await request.post('/api/mirror-folders').send({ name: 'bad name!' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/letters, numbers, dashes/i);
    });

    it('creates a valid folder that appears on subsequent GET', async () => {
      const name = `itest_${Date.now()}`;
      const post = await request.post('/api/mirror-folders').send({ name });
      expect(post.status).toBe(200);
      expect(post.body.created).toBe(name);

      const list = await request.get('/api/mirror-folders');
      expect(list.status).toBe(200);
      expect(list.body.folders).toContain(name);
    });
  });
});
