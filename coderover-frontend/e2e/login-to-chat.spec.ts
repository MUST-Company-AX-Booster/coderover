import { test, expect } from '@playwright/test';

test.describe('Login to Chat smoke flow', () => {
  test('redirects unauthenticated user to login page', async ({ page }) => {
    await page.goto('/chat');
    await expect(page).toHaveURL(/\/login/);
  });

  test('login page renders correctly', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText('Welcome back')).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByRole('button', { name: /GitHub/ })).toBeVisible();
  });

  test('shows validation errors for empty form', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('button', { name: 'Sign in' }).click();
    // Zod validation will show error messages
    await expect(page.getByText(/Invalid email/i)).toBeVisible();
  });

  test('login with credentials navigates to dashboard', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('demo@example.com');
    await page.getByLabel('Password').fill('password123');

    // Mock the API response
    await page.route('**/auth/login', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          accessToken: 'e2e-test-token',
          user: { id: 'u1', email: 'demo@example.com', role: 'admin' },
        }),
      });
    });

    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 10_000 });
  });

  test('authenticated user can navigate to chat', async ({ page }) => {
    // Set auth state in localStorage before navigating
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

    // Mock API calls that ChatPage makes
    await page.route('**/copilot/sessions', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });
    await page.route('**/repos', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    });

    await page.goto('/chat');
    await expect(page.getByText('Ask anything about your code')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder('Ask about your codebase...')).toBeVisible();
  });
});
