import { test, expect } from '@playwright/test';

const TEST_HOST = 'quay.e2e-cleanup.local:8443';

test.describe('Registry Cleanup tab', () => {
  let originalPullSecret: string;
  let registryId: string | undefined;

  test.beforeAll(async ({ request }) => {
    const current = await request.get('/api/pull-secret/content');
    originalPullSecret = (await current.json()).content ?? '';
    const auths = originalPullSecret
      ? JSON.parse(originalPullSecret).auths ?? {}
      : {};
    auths[TEST_HOST] = {
      auth: Buffer.from('e2e-user:e2e-pass').toString('base64'),
    };
    const saved = await request.post('/api/pull-secret', {
      data: { content: JSON.stringify({ auths }) },
    });
    expect(saved.ok(), await saved.text()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    if (registryId) {
      await request
        .delete(`/api/mirror-registries/${registryId}`)
        .catch(() => undefined);
    }
    if (originalPullSecret) {
      await request.post('/api/pull-secret', {
        data: { content: originalPullSecret },
      });
    } else {
      await request.delete('/api/pull-secret').catch(() => undefined);
    }
  });

  test('empty state, options, never-scanned call-to-action', async ({
    page,
    request,
  }) => {
    await page.goto('/config');
    await page.getByRole('tab', { name: /registry cleanup/i }).click();
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible();

    const created = await request.post('/api/mirror-registries', {
      data: { host: TEST_HOST, pathPrefix: 'cleanup' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    registryId = (await created.json()).registry.id;

    await page.reload();
    await page.getByRole('tab', { name: /registry cleanup/i }).click();
    await expect(
      page.getByLabel('Include additionalImages'),
    ).toBeChecked();
    await expect(
      page.getByLabel('Strict mode (fail on unverifiable)'),
    ).not.toBeChecked();

    await page.getByRole('button', { name: /^generate$/i }).click();
    await expect(page.getByText('Never scanned')).toBeVisible({
      timeout: 10000,
    });
  });
});
