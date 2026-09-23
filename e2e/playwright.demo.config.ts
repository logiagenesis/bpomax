import { defineConfig, devices } from '@playwright/test';

/**
 * The demo build (D-043): `pnpm build:web:demo` into apps/web/dist-demo, served on its own
 * port so it never mixes with the e2e build the other specs run against.
 */
const PORT = 4174;

export default defineConfig({
  testDir: '.',
  testMatch: 'demo.spec.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github']] : [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}` },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm --filter @arbitron/web exec vite preview --outDir ../dist-demo --port ${PORT} --strictPort --host 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: '..',
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
