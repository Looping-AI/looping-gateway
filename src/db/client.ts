import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Db = DrizzleD1Database<typeof schema>;

/** Wrap the D1 binding in a typed Drizzle client. The only env touchpoint. */
export function getDb(env: Pick<Env, "DB">): Db {
  return drizzle(env.DB, { schema });
}
