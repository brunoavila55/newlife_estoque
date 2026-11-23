import { defineConfig, devices } from '@playwright/test'

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:4173',
    launchOptions: executablePath ? { executablePath } : undefined,
  },
  webServer: {
    command: 'npm run preview -- --host localhost --port 4173 --strictPort',
    url: 'http://localhost:4173',
  },
})
