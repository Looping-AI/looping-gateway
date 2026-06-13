import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SLACK_BOT_TOKEN: "xoxb-test-token",
          SLACK_SIGNING_SECRET: "test-signing-secret"
        }
      }
    })
  ]
});
