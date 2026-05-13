import { test, expect } from '@playwright/test';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/settings');
  });

  test('settings page loads with tabs', async ({ page }) => {
    await expect(page.getByText(/pull secret|cache|registry/i).first()).toBeVisible();
  });

  test('Cache tab shows cache location and cleanup button', async ({ page }) => {
    await page.getByText(/cache/i).first().click();
    await expect(page.getByText(/cache location|cache size|clean up cache/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('Registry tab shows authentication status', async ({ page }) => {
    await page.getByText(/registry/i).first().click();
    await expect(page.getByText(/registry authentication|no registries found|verify all/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('Pull Secret Save button is present', async ({ page }) => {
    const saveBtn = page.getByRole('button', { name: /^Save$/i });
    await expect(saveBtn).toBeVisible({ timeout: 10000 });
  });

  test('Cache tab shows Change Cache Location section with restart command generation', async ({ page }) => {
    await page.getByText(/cache/i).first().click();
    const toggle = page.getByText(/change cache location/i);
    await expect(toggle).toBeVisible({ timeout: 10000 });
    await toggle.click();
    await expect(page.getByPlaceholder(/mnt\/fast-ssd/i)).toBeVisible();
    await page.getByPlaceholder(/mnt\/fast-ssd/i).fill('/tmp/test-cache');
    await page.getByRole('button', { name: /generate restart command/i }).click();
    await expect(page.getByText(/CACHE_DIR.*mirror-gui\.sh.*--restart/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/run the command above on the host/i)).toBeVisible();
  });

  test('Sync Catalogs tab shows sync button and clear button', async ({ page }) => {
    await page.getByText(/sync catalogs/i).first().click();
    await expect(page.getByRole('button', { name: /sync catalogs/i })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /clear sync data/i })).toBeVisible({ timeout: 10000 });
  });
});
