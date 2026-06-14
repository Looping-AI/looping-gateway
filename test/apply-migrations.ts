import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). It's a
// test-only binding, so cast rather than widen the generated production Env.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;

// Apply the drizzle-generated schema to the test D1 once per test file.
beforeAll(async () => {
  await applyD1Migrations(env.DB, migrations);
});
