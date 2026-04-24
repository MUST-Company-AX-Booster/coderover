import { test, expect } from '@playwright/test';

test.describe('Login to Ingest smoke flow', () => {
  test.beforeEach(async ({ page }) => {
    // Pre-authenticate by setting localStorage
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.setItem(
        'auth-storage',
        JSON.stringify({
          state: {
            token: 'e2e-test-token',
            user: { id: 'u1', email: 'demo@example.com', role: 'admin' },
            isAuthenticated: true,
          },
          version: 0,
        }),
      );
    });
  });

  test('repos page loads and shows empty state', async ({ page }) => {
    await page.route('**/repos', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }
    });

    await page.goto('/repos');
    await expect(page.getByText('No repositories yet')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Add Repository/i })).toBeVisible();
  });

  test('repos page displays repository list', async ({ page }) => {
    await page.route('**/repos', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            { id: 'r1', fullName: 'org/my-app', label: 'My App', branch: 'main', language: 'TypeScript', fileCount: 200, isActive: true },
          ]),
        });
      }
    });

    await page.goto('/repos');
    await expect(page.getByText('My App')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('main')).toBeVisible();
  });

  test('add repository modal opens and has required fields', async ({ page }) => {
    await page.route('**/repos', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      }
    });

    await page.goto('/repos');
    await page.getByRole('button', { name: /Add Repository/i }).first().click();

    await expect(page.getByPlaceholder('https://github.com/owner/repo')).toBeVisible();
    await expect(page.getByPlaceholder('My Repository')).toBeVisible();
    await expect(page.getByPlaceholder('main')).toBeVisible();
  });

  test('can submit add repository form', async ({ page }) => {
    await page.route('**/repos', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([]),
        });
      } else if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            id: 'r-new',
            fullName: 'org/new-repo',
            label: 'New Repo',
            branch: 'main',
            language: null,
            fileCount: 0,
            isActive: true,
          }),
        });
      }
    });

    await page.goto('/repos');
    await page.getByRole('button', { name: /Add Repository/i }).first().click();

    await page.getByPlaceholder('https://github.com/owner/repo').fill('https://github.com/org/new-repo');
    await page.getByPlaceholder('My Repository').fill('New Repo');
    await page.getByPlaceholder('main').fill('main');

    await page.getByRole('button', { name: 'Add Repository' }).last().click();

    await expect(page.getByText('New Repo')).toBeVisible({ timeout: 10_000 });
  });
});
