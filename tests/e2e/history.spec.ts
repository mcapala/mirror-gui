import { test, expect } from '@playwright/test';

test.describe('History', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/history');
  });

  test('history page loads', async ({ page }) => {
    await expect(page).toHaveURL(/\/history/);
    await expect(page.getByText('Operation History').first()).toBeVisible({ timeout: 15000 });
  });

  test('filter dropdown is present', async ({ page }) => {
    await expect(page.getByLabel('Filter operations')).toBeVisible({ timeout: 15000 });
  });

  test('export button is present', async ({ page }) => {
    await expect(page.getByText('Export CSV').first()).toBeVisible({ timeout: 15000 });
  });

  test('filter dropdown shows all status options', async ({ page }) => {
    const toggle = page.getByLabel('Filter operations');
    await expect(toggle).toBeVisible({ timeout: 15000 });
    await toggle.click();
    await expect(page.getByRole('option', { name: 'All Operations' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Successful' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Failed' })).toBeVisible();
    await expect(page.getByRole('option', { name: 'Stopped' })).toBeVisible();
  });

  test('select all checkbox is present when operations exist', async ({ page }) => {
    const table = page.locator('table');
    const emptyState = page.getByText('No operations found.');
    const hasTable = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasTable) {
      await expect(table.locator('thead input[type="checkbox"]')).toBeVisible();
    } else {
      await expect(emptyState).toBeVisible();
    }
  });

  test('Delete All button is present when operations exist', async ({ page }) => {
    const table = page.locator('table');
    const hasTable = await table.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasTable) {
      await expect(page.getByRole('button', { name: /delete all/i })).toBeVisible();
    }
  });
});
