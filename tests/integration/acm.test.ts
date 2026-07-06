import { describe, it, expect, beforeAll } from 'vitest';
import { getTestApp } from './helpers/testApp.js';

describe('ACM API (mounted on real app)', () => {
  let request: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    request = await getTestApp();
  });

  it('GET /api/acm/hubs returns an empty hubs array', async () => {
    const res = await request.get('/api/acm/hubs');
    expect(res.status).toBe(200);
    expect(res.body.hubs).toEqual([]);
  });

  it('GET /api/acm/snapshot 404s before first refresh', async () => {
    const res = await request.get('/api/acm/snapshot');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/never refreshed/i);
  });
});
