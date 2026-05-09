import { test, expect } from '@playwright/test';

test.describe('Mirror Operations', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/operations');
  });

  test('operations page loads', async ({ page }) => {
    await expect(page.getByText(/mirror operations|operation/i).first()).toBeVisible();
  });

  test('config file selector is present', async ({ page }) => {
    await expect(page.getByText(/config|configuration|select/i)).toBeVisible();
  });

  test('start operation form is present', async ({ page }) => {
    await expect(page.getByText(/start|run|configuration/i).first()).toBeVisible();
  });

  test('operations table or content renders', async ({ page }) => {
    await expect(page.locator('table, [role="grid"], .pf-v6-c-table, main').first()).toBeVisible({ timeout: 10000 });
  });

  test('ImageSetConfiguration File label is present', async ({ page }) => {
    await expect(page.getByText('ImageSetConfiguration File', { exact: true })).toBeVisible({ timeout: 10000 });
  });

  test('Mirror Destination Folder label is present', async ({ page }) => {
    await expect(page.getByText('Mirror Destination Folder')).toBeVisible({ timeout: 10000 });
  });

  test('Operations section title renders', async ({ page }) => {
    await expect(
      page.locator('#operation-history-card').getByRole('heading', { name: 'Operations', exact: true }),
    ).toBeVisible({ timeout: 10000 });
  });

  test('Start New Operation card title renders', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Start New Operation' })).toBeVisible({ timeout: 10000 });
  });

  test('operations table shows row actions or empty state', async ({ page }) => {
    await expect(page.locator('#operation-history-card')).toBeVisible({ timeout: 10000 });
    const emptyState = page.locator('#operation-history-card').getByText('No operations found.');
    const actionsToggle = page.locator('#operation-history-card button[aria-label^="Actions for "]').first();
    await expect(emptyState.or(actionsToggle)).toBeVisible({ timeout: 10000 });
  });
});
