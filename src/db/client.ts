import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { env } from "cloudflare:workers";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

let _db: Db | undefined;

/** Typed Drizzle client over the D1 binding, memoized per isolate. */
export function getDb(): Db {
  return (_db ??= drizzle(env.DB, { schema }));
}
