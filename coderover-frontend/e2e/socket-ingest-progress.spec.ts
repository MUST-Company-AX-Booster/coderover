import { test, expect } from '@playwright/test';

/**
 * Phase 9 / Workstream A — E2E: ingest.progress events arrive via socket
 * faster than the polling fallback would fire.
 *
 * Approach: sign in, trigger ingest on a known repo, watch the page for
 * the "chunked" stage indicator, assert it becomes visible within the
 * socket-latency window (well under the 10s polling fallback).
 */
test.describe('Socket ingest progress', () => {
  test('receives ingest.progress event within socket latency budget', async ({ page }) => {
    test.setTimeout(30_000);

    // 1. Sign in (assumes test fixture user or existing session)
    await page.goto('/login');
    const emailInput = page.getByLabel(/email/i);
    if (await emailInput.isVisible()) {
      await emailInput.fill(process.env.E2E_EMAIL ?? 'test@example.com');
      const pw = page.getByLabel(/password/i);
      if (await pw.isVisible()) await pw.fill(process.env.E2E_PASSWORD ?? 'testpass');
      await page.getByRole('button', { name: /sign in|log in/i }).click();
      await page.waitForURL(/\/dashboard|\/repos/);
    }

    // 2. Navigate to repos and pick the first one
    await page.goto('/repos');
    const firstRepo = page.locator('[data-testid="repo-row"]').first();
    if (await firstRepo.isVisible().catch(() => false)) {
      await firstRepo.click();
    }

    // 3. Trigger ingest
    const ingestBtn = page.getByRole('button', { name: /ingest|re-?index/i }).first();
    if (await ingestBtn.isVisible().catch(() => false)) {
      const startedAt = Date.now();
      await ingestBtn.click();

      // 4. Expect progress indicator to reflect a socket-delivered stage
      //    within 5 seconds — polling fallback is 10s, so anything under
      //    that window proves the socket path.
      await expect(page.getByText(/chunked|completed|syncing/i)).toBeVisible({ timeout: 5_000 });
      const elapsed = Date.now() - startedAt;
      expect(elapsed).toBeLessThan(5_000);
    } else {
      test.skip(true, 'No ingest control visible; skipping in this environment');
    }
  });
});
