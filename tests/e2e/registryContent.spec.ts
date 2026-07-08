import { test, expect } from '@playwright/test';

const TEST_HOST = 'quay.e2e-registry.local:8443';

test.describe('Registry Content page', () => {
  let registryId: string | undefined;

  test.afterAll(async ({ request }) => {
    if (registryId) {
      await request
        .delete(`/api/mirror-registries/${registryId}`)
        .catch(() => undefined);
    }
  });

  test('sidebar Fleet State group navigates to Registry Content', async ({
    page,
  }) => {
    await page.goto('/');
    // The Fleet State group is expanded by default; its children are visible.
    await expect(page.getByText('Fleet State').first()).toBeVisible();
    await page.getByText('Registry Content').first().click();
    await expect(page).toHaveURL(/\/registry-content$/);
  });

  test('empty state links to Settings, API-created registry shows never-scanned', async ({
    page,
    request,
  }) => {
    // Leftovers from other specs (or an earlier failed run) break the
    // empty-state assumption — clear all mirror registries first.
    const existing = await request.get('/api/mirror-registries');
    for (const r of (await existing.json()).registries as { id: string }[]) {
      await request.delete(`/api/mirror-registries/${r.id}`);
    }

    await page.goto('/registry-content');
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Settings → Registry' }),
    ).toBeVisible();

    const created = await request.post('/api/mirror-registries', {
      data: { host: TEST_HOST, pathPrefix: 'mirror' },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    registryId = (await created.json()).registry.id;
    await page.reload();

    await expect(
      page.getByText('Never scanned').filter({ visible: true }),
    ).toBeVisible({ timeout: 10000 });
    // CRUD moved to Settings — no add/delete controls on this page.
    await expect(
      page.getByRole('button', { name: /add registry/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /^delete$/i }),
    ).toHaveCount(0);

    await request.delete(`/api/mirror-registries/${registryId}`);
    registryId = undefined;
    await page.reload();
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible({ timeout: 10000 });
  });
});
