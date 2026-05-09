import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('dashboard page renders environment section', async ({ page }) => {
    await expect(page.getByText(/environment|Mirror-GUI|version/i)).toBeVisible();
  });

  test('operation stats cards display', async ({ page }) => {
    await expect(page.getByText(/total|successful|failed|running|operations/i).first()).toBeVisible({ timeout: 10000 });
  });

  test('recent operations section renders', async ({ page }) => {
    await expect(page.getByText('Recent Operations').first()).toBeVisible({ timeout: 10000 });
  });

  test('quick action buttons are present', async ({ page }) => {
    await expect(page.getByText(/create configuration|view operations|view history/i).first()).toBeVisible();
  });

  test('recent operations table has Config column header', async ({ page }) => {
    const table = page.locator('table[aria-label="Recent operations"]');
    const emptyState = page.getByText('No recent operations found.');
    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });
    if (await table.isVisible()) {
      await expect(table.getByRole('columnheader', { name: 'Config' })).toBeVisible();
    }
  });

  test('recent operations duration column shows clock icon when rows exist', async ({ page }) => {
    const table = page.locator('table[aria-label="Recent operations"]');
    const emptyState = page.getByText('No recent operations found.');
    await expect(table.or(emptyState)).toBeVisible({ timeout: 10000 });
    if (await table.isVisible()) {
      const durationCell = table.locator('tbody tr').first().getByRole('cell', { name: 'Duration' });
      if ((await durationCell.count()) > 0) {
        await expect(durationCell.locator('svg')).toBeVisible();
      }
    }
  });
});
