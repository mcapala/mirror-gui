import { test, expect } from '@playwright/test';
import https from 'https';
import fs from 'fs';
import path from 'path';

const TLS_DIR = path.resolve('tests/fixtures/tls');
const HUB_NAME = 'e2e-stub-hub';

// A stub ACM Search API: answers every POST with two ACM CSVs on two
// clusters, one of them behind the fixture catalog's latest (2.16.0).
const STUB_RESPONSE = {
  data: {
    searchResult: [
      {
        items: [
          {
            kind: 'ClusterServiceVersion',
            name: 'advanced-cluster-management.v2.15.0',
            cluster: 'e2e-cluster-1',
            phase: 'Succeeded',
          },
          {
            kind: 'ClusterServiceVersion',
            name: 'advanced-cluster-management.v2.16.0',
            cluster: 'e2e-cluster-2',
            phase: 'Succeeded',
          },
        ],
      },
    ],
  },
};

let server: https.Server;
let port: number;

test.beforeAll(async () => {
  server = https.createServer(
    {
      key: fs.readFileSync(path.join(TLS_DIR, 'server.key')),
      cert: fs.readFileSync(path.join(TLS_DIR, 'server.crt')),
    },
    (req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(STUB_RESPONSE));
      });
    }
  );
  await new Promise<void>(resolve =>
    server.listen(0, '127.0.0.1', () => resolve())
  );
  const address = server.address();
  port = typeof address === 'object' && address ? address.port : 0;
});

test.afterAll(async () => {
  await new Promise(resolve => server.close(resolve));
});

test.describe('Fleet Operators', () => {
  let hubId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (!hubId) return;
    try {
      await request.delete(`/api/acm/hubs/${hubId}`);
    } catch (error) {
      console.warn(`fleetOperators cleanup: failed to delete hub ${hubId}:`, error);
    }
  });

  test('configure hub, refresh, dashboard shows deployed packages', async ({
    page,
    request,
  }) => {
    const created = await request.post('/api/acm/hubs', {
      data: {
        name: HUB_NAME,
        url: `https://127.0.0.1:${port}`,
        token: 'sha256~e2e-test-token',
        insecureSkipVerify: true,
      },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    hubId = (await created.json()).hub.id;

    await page.goto('/fleet');
    await expect(
      page.getByRole('heading', { name: 'Fleet Operators' })
    ).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /refresh/i }).click();

    await expect(
      page.getByText('advanced-cluster-management')
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(`${HUB_NAME}: 2 clusters`)).toBeVisible();
    await expect(page.getByText('behind').first()).toBeVisible();
  });
});
