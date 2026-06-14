import { defineConfig } from "vitest/config";
import {
  cloudflareTest,
  readD1Migrations
} from "@cloudflare/vitest-pool-workers";
import path from "path";

// Read the drizzle-generated migrations on the Node side and hand them to the
// pool as a binding; test/apply-migrations.ts applies them to the test D1.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  test: {
    setupFiles: ["./test/apply-migrations.ts"]
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SLACK_BOT_TOKEN: "xoxb-test-token",
          SLACK_SIGNING_SECRET: "test-signing-secret",
          TEST_MIGRATIONS: migrations
        }
      }
    })
  ]
});
