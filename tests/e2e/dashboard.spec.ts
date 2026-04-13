import { test, expect } from '@playwright/test';

test.describe('Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('dashboard page renders system overview section', async ({ page }) => {
    await expect(page.getByText(/system overview|Mirror-GUI|version/i)).toBeVisible();
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
});
