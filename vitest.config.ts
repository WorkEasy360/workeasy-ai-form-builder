import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

/**
 * `*.shared.test.ts` files run in both Node (unit) and headless Chromium
 * (browser) to prove that browser and server produce identical results.
 */
const SHARED_TESTS = ["packages/*/src/**/*.shared.test.ts"];
/** Tests that need a real DOM run only in the browser project. */
const BROWSER_ONLY_TESTS = ["packages/*/src/**/*.browser.test.tsx"];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      {
        // Needs `pnpm infra:up`; recreates and migrates a dedicated test database.
        test: {
          name: "integration",
          environment: "node",
          include: ["apps/*/src/**/*.int.test.ts", "packages/*/src/**/*.int.test.ts"],
          globalSetup: ["packages/database/src/testing/global-setup.ts"],
          testTimeout: 20_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Needs `pnpm browsers:install` once.
        test: {
          name: "browser",
          include: [...SHARED_TESTS, ...BROWSER_ONLY_TESTS],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            screenshotFailures: false,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
