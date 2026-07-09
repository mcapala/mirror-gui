import { test, expect } from '@playwright/test';
import https from 'https';
import fs from 'fs';
import path from 'path';

const TLS_DIR = path.resolve('tests/fixtures/tls');
const HUB_NAME = 'e2e-updates-hub';

function stubResponse(
  csvs: Array<{ name: string; cluster: string }>,
  clusters: Array<{ name: string; openshiftVersion: string }>,
) {
  return {
    data: {
      searchResult: [
        {
          items: csvs.map(csv => ({
            kind: 'ClusterServiceVersion',
            name: csv.name,
            cluster: csv.cluster,
            phase: 'Succeeded',
          })),
        },
        {
          items: clusters.map(c => ({
            kind: 'Cluster',
            name: c.name,
            openshiftVersion: c.openshiftVersion,
          })),
        },
      ],
    },
  };
}

let currentStubResponse = stubResponse(
  [{ name: 'advanced-cluster-management.v2.15.0', cluster: 'e2e-cluster-1' }],
  [{ name: 'e2e-cluster-1', openshiftVersion: '4.16.8' }],
);

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
        res.end(JSON.stringify(currentStubResponse));
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
        // opt-in semantics: a hub without a cluster selection is skipped
        clusters: ['e2e-cluster-1'],
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

  test('seeds suggestions from an empty ISC and select-all applies them', async ({
    page,
    request,
  }) => {
    // two deployed operators, both only in the bundled redhat catalog
    currentStubResponse = stubResponse(
      [
        { name: 'advanced-cluster-management.v2.15.0', cluster: 'e2e-cluster-1' },
        // csvNamePrefixes alias: update-service-operator → cincinnati-operator
        { name: 'update-service-operator.v4.6.0', cluster: 'e2e-cluster-1' },
      ],
      [{ name: 'e2e-cluster-1', openshiftVersion: '4.16.8' }],
    );
    const refreshed = await request.post('/api/acm/refresh');
    expect(refreshed.ok(), await refreshed.text()).toBeTruthy();

    // fresh context → empty sessionStorage draft → empty ISC in the editor
    await page.goto('/config');
    await page.getByRole('tab', { name: /fleet updates/i }).click();
    await page.getByRole('button', { name: /suggest updates/i }).click();

    // exact: the hidden Operators tab has an "Add operator catalog" button
    await expect(
      page.getByText('Add operator', { exact: true }).first(),
    ).toBeVisible({ timeout: 20000 });
    // .first(): names also appear in the evidence ("... is deployed on ...")
    await expect(
      page.getByText('advanced-cluster-management').first(),
    ).toBeVisible();
    await expect(page.getByText('cincinnati-operator').first()).toBeVisible();
    // zero fleet-wide warnings → no notices section (Task 7 renders it)
    await expect(page.getByRole('button', { name: /notice/i })).toHaveCount(0);

    const selectAll = page.locator('#sugg-select-all');
    // seeded suggestions are not default-checked
    await expect(selectAll).not.toBeChecked();
    await expect(
      page.getByRole('button', { name: /apply selected \(0\)/i }),
    ).toBeDisabled();

    // one row checked → header goes indeterminate
    await page
      .locator('input[id^="sugg-"]:not(#sugg-select-all)')
      .first()
      .check();
    await expect(selectAll).toHaveJSProperty('indeterminate', true);

    // select-all checks every row
    await selectAll.click();
    await expect(selectAll).toBeChecked();
    await page.getByRole('button', { name: /apply selected \(2\)/i }).click();

    await page.getByRole('tab', { name: /preview/i }).click();
    const preview = page.locator('#yaml-preview');
    await expect(preview).toContainText('redhat-operator-index:v4.21');
    await expect(preview).toContainText('advanced-cluster-management');
    await expect(preview).toContainText('minVersion: 2.15.0');
    await expect(preview).toContainText('cincinnati-operator');
    await expect(preview).toContainText('minVersion: 4.6.0');
  });
});
