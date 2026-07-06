import { test, expect } from '@playwright/test';
import https from 'https';
import fs from 'fs';
import path from 'path';

const TLS_DIR = path.resolve('tests/fixtures/tls');
const HUB_NAME = 'e2e-updates-hub';

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
        ],
      },
      {
        items: [
          { kind: 'Cluster', name: 'e2e-cluster-1', openshiftVersion: '4.16.8' },
        ],
      },
    ],
  },
};

const ISC_YAML = `kind: ImageSetConfiguration
apiVersion: mirror.openshift.io/v2alpha1
mirror:
  platform:
    channels:
      - name: stable-4.16
        type: ocp
  operators:
    - catalog: registry.redhat.io/redhat/redhat-operator-index:v4.21
      packages:
        - name: advanced-cluster-management
          channels:
            - name: release-2.15
`;

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

test.describe('Fleet Updates tab', () => {
  let hubId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (!hubId) return;
    try {
      await request.delete(`/api/acm/hubs/${hubId}`);
    } catch (error) {
      console.warn(`fleetUpdates cleanup: failed to delete hub ${hubId}:`, error);
    }
  });

  test('suggests and applies a minVersion floor from the fleet', async ({
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

    const refreshed = await request.post('/api/acm/refresh');
    expect(refreshed.ok(), await refreshed.text()).toBeTruthy();

    await page.goto('/config');
    await page.getByRole('tab', { name: /load configuration/i }).click();
    await page
      .locator('input[type="file"]')
      .setInputFiles({
        name: 'e2e-isc.yaml',
        mimeType: 'text/yaml',
        buffer: Buffer.from(ISC_YAML),
      });
    await expect(
      page.getByText('Valid ImageSetConfiguration detected')
    ).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: /load into editor/i }).click();

    await page.getByRole('tab', { name: /fleet updates/i }).click();
    await page.getByRole('button', { name: /suggest updates/i }).click();

    // raise-min-version for release-2.15 → 2.15.0, pre-checked
    await expect(
      page.getByText('advanced-cluster-management / release-2.15')
    ).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Raise minVersion').first()).toBeVisible();

    await page.getByRole('button', { name: /apply selected/i }).click();

    await page.getByRole('tab', { name: /preview/i }).click();
    await expect(page.locator('#yaml-preview')).toContainText('minVersion: 2.15.0');
    await expect(page.locator('#yaml-preview')).toContainText('minVersion: 4.16.8');
  });
});
