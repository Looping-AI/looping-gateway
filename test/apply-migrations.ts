import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

// TEST_MIGRATIONS is injected by vitest.config.ts (readD1Migrations). It's a
// test-only binding, so cast rather than widen the generated production Env.
const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] })
  .TEST_MIGRATIONS;

// Reset all storage and re-apply the schema before every test so each test
// starts from a clean slate.
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, migrations);
});
