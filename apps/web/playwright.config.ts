import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PORT ?? 3000);
const mockPort = Number(process.env.MOCK_API_PORT ?? 4010);
// A webServer `env` replaces the inherited environment, so pass it through.
const env = (extra: Record<string, string>) => ({ ...(process.env as Record<string, string>), ...extra });

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /phase0/ },
  ],
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : [
        {
          command: `node e2e/mock-api.mjs`,
          port: mockPort,
          reuseExistingServer: true,
          env: env({ MOCK_API_PORT: String(mockPort) }),
        },
        {
          command: `pnpm start -p ${port}`,
          port,
          reuseExistingServer: true,
          timeout: 60_000,
          // Offline AI: recorded assistant turns instead of Claude (see e2e/ai-script.json).
          env: env({
            AI_PROVIDER: "scripted",
            AI_SCRIPT_FILE: fileURLToPath(new URL("./e2e/ai-script.json", import.meta.url)),
          }),
        },
        {
          // The stream engine owns /t/...; the web app forwards to it.
          command: "pnpm --filter @oicr/stream start",
          url: "http://127.0.0.1:3001/healthz",
          reuseExistingServer: true,
          env: env({ STREAM_PORT: "3001" }),
        },
        {
          command: "pnpm --filter @oicr/worker start",
          // No port: wait for its start-up log line.
          wait: { stdout: /worker started/ },
          env: env({ SCHEDULER_TICK_MS: "2000" }),
          stdout: "pipe",
        },
      ],
});
