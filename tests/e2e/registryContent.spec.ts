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
    // NavExpandable renders a toggle button; expanded by default, so tolerate
    // the already-open state.
    await page
      .getByRole('button', { name: /fleet state/i })
      .click()
      .catch(() => undefined);
    await page.getByRole('link', { name: /registry content/i }).click();
    await expect(page).toHaveURL(/\/registry-content$/);
  });

  test('empty state links to Settings, API-created registry shows never-scanned', async ({
    page,
    request,
  }) => {
    await page.goto('/registry-content');
    await expect(
      page
        .getByText('No mirror registries configured')
        .filter({ visible: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: /settings/i }),
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
