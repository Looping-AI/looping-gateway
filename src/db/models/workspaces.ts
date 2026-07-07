import { eq, sql } from "drizzle-orm";
import { getDb } from "../client";
import * as schema from "../schema";

export type WorkspaceRow = typeof schema.workspaces.$inferSelect;

/** Workspace 0 — the org-level workspace sentinel. */
export const ORG_WORKSPACE_ID = 0;

export interface CreateWorkspaceInput {
  name: string;
  adminChannelId?: string | null;
}

export async function createWorkspace(
  input: CreateWorkspaceInput
): Promise<WorkspaceRow> {
  const db = getDb();
  const rows = await db
    .insert(schema.workspaces)
    .values({
      name: input.name,
      adminChannelId: input.adminChannelId ?? null
    })
    .returning();
  return rows[0];
}

export interface UpsertWorkspaceInput {
  id: number;
  name: string;
  adminChannelId?: string | null;
}

export async function upsertWorkspace(
  input: UpsertWorkspaceInput
): Promise<void> {
  const db = getDb();
  await db
    .insert(schema.workspaces)
    .values({
      id: input.id,
      name: input.name,
      adminChannelId: input.adminChannelId ?? null
    })
    .onConflictDoUpdate({
      target: schema.workspaces.id,
      set: {
        name: input.name,
        ...(input.adminChannelId != null
          ? { adminChannelId: input.adminChannelId }
          : {}),
        updatedAt: sql`(unixepoch())`
      }
    });
}

export async function getWorkspace(id: number): Promise<WorkspaceRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceByAdminChannel(
  channelId: string
): Promise<WorkspaceRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.adminChannelId, channelId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listWorkspaces(): Promise<WorkspaceRow[]> {
  const db = getDb();
  return db.select().from(schema.workspaces);
}

export async function setWorkspaceAdminChannel(
  id: number,
  channelId: string | null
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.workspaces)
    .set({ adminChannelId: channelId, updatedAt: sql`(unixepoch())` })
    .where(eq(schema.workspaces.id, id));
}
