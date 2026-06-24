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
          // Fixed Ed25519 private JWK for deterministic JWT sign/verify in tests.
          GATEWAY_JWT_PRIVATE_KEY: JSON.stringify({
            crv: "Ed25519",
            d: "1xgbYpMkLQ7HSsmNt-fKKJq2UFstxDxuzpZ_30tl7bs",
            x: "HozhHMwqLW4u9YAyv3UBLj3tcQrLi9lUA335i3xdFE8",
            kty: "OKP",
            kid: "gw-test-1",
            alg: "EdDSA",
            use: "sig"
          }),
          TEST_MIGRATIONS: migrations
        }
      }
    })
  ]
});
