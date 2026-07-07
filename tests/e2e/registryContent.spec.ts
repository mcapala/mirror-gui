import { test, expect } from '@playwright/test';

const TEST_HOST = 'quay.e2e-registry.local:8443';

test.describe('Registry Content tab', () => {
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

  test('empty state, add registry, never-scanned state, delete', async ({
    page,
    request,
  }) => {
    await page.goto('/config');
    await page.getByRole('tab', { name: /registry content/i }).click();
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: /add registry/i }).click();
    await page
      .locator('#registry-host')
      .selectOption({ label: TEST_HOST });
    await page.locator('#registry-prefix').fill('mirror');
    await page.getByRole('button', { name: /save registry/i }).click();

    await expect(page.getByText('Never scanned')).toBeVisible({
      timeout: 10000,
    });

    const list = await request.get('/api/mirror-registries');
    const registries = (await list.json()).registries;
    registryId = registries.find(
      (r: { host: string }) => r.host === TEST_HOST,
    )?.id;
    expect(registryId).toBeTruthy();

    await page.getByRole('button', { name: /^delete$/i }).click();
    await page.getByRole('button', { name: /confirm delete/i }).click();
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible({ timeout: 10000 });
    registryId = undefined;
  });
});
