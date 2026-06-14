import { defineConfig } from "drizzle-kit";

// `out` doubles as wrangler's `migrations_dir` and the vitest pool's
// readD1Migrations() source, so drizzle-kit-generated SQL is the single source
// of truth for the schema. Built-in seeds live in migrations/0001_seed_builtins.sql.
export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dialect: "sqlite"
});
