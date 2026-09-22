import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

export default defineConfig({
  testDir: '.',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Set PLAYWRIGHT_CHROMIUM_EXECUTABLE to reuse a Chromium already on the machine
        // instead of downloading one (sandboxes, air-gapped CI). Unset everywhere else.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],
  webServer: {
    // Serve only. The build is a separate step (pnpm test:e2e, and its own CI step) so a
    // build failure surfaces as a build failure instead of a silent 120s server timeout.
    command: `pnpm --filter @arbitron/web preview --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: '..',
    // Without these the server's own output never reaches the log, which is what made
    // the first CI failure undiagnosable.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
