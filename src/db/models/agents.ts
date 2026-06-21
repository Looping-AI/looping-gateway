import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

export type AgentRow = typeof schema.agents.$inferSelect;
export type AgentKind = AgentRow["kind"];

export interface RegisterAgentInput {
  name: string;
  kind: AgentKind;
  displayName?: string | null;
  /** Required: custom agents are remote and addressed by this HTTP endpoint. */
  a2aEndpoint: string;
  workspaceId: number | null;
  /** Pinned AgentCard signing identity (custom agents; verified at registration). */
  cardSigningJku?: string | null;
  cardSigningKid?: string | null;
}

/** Patch for `updateAgent` — only provided fields are written. */
export interface UpdateAgentPatch {
  displayName?: string | null;
  a2aEndpoint?: string;
  enabled?: boolean;
  cardSigningJku?: string | null;
  cardSigningKid?: string | null;
}

export interface AgentChannelEntry {
  agent: AgentRow;
  /** Workspace scope from the agent_channels row (not agents.workspace_id). */
  workspaceId: number | null;
}

export async function getAgent(db: Db, name: string): Promise<AgentRow | null> {
  const rows = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.name, name))
    .limit(1);
  return rows[0] ?? null;
}

export async function listAgents(db: Db): Promise<AgentRow[]> {
  return db.select().from(schema.agents);
}

/** Enabled agents configured for a channel, used for the no-::name default routing path. */
export async function getAgentsForChannel(
  db: Db,
  channelId: string
): Promise<AgentChannelEntry[]> {
  const rows = await db
    .select({
      agent: schema.agents,
      workspaceId: schema.agentChannels.workspaceId
    })
    .from(schema.agentChannels)
    .innerJoin(
      schema.agents,
      eq(schema.agentChannels.agentName, schema.agents.name)
    )
    .where(
      and(
        eq(schema.agentChannels.channelId, channelId),
        eq(schema.agents.enabled, true)
      )
    );
  return rows;
}

/** Check if a specific agent is configured and enabled for a channel (for the ::name validation path). */
export async function getAgentInChannel(
  db: Db,
  channelId: string,
  agentName: string
): Promise<AgentChannelEntry | null> {
  const rows = await db
    .select({
      agent: schema.agents,
      workspaceId: schema.agentChannels.workspaceId
    })
    .from(schema.agentChannels)
    .innerJoin(
      schema.agents,
      eq(schema.agentChannels.agentName, schema.agents.name)
    )
    .where(
      and(
        eq(schema.agentChannels.channelId, channelId),
        eq(schema.agentChannels.agentName, agentName),
        eq(schema.agents.enabled, true)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** All agents scoped to a workspace (registry CRUD listing for one admin instance). */
export async function listAgentsForWorkspace(
  db: Db,
  workspaceId: number
): Promise<AgentRow[]> {
  return db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.workspaceId, workspaceId));
}

/** Channel ids this agent is attached to (via agent_channels). */
export async function getAgentChannels(
  db: Db,
  agentName: string
): Promise<string[]> {
  const rows = await db
    .select({ channelId: schema.agentChannels.channelId })
    .from(schema.agentChannels)
    .where(eq(schema.agentChannels.agentName, agentName));
  return rows.map((r) => r.channelId);
}

/** Channel ids for a set of agents in one query (avoids N+1 in list paths). */
export async function listChannelsForAgents(
  db: Db,
  agentNames: string[]
): Promise<{ agentName: string; channelId: string }[]> {
  if (agentNames.length === 0) return [];
  return db
    .select({
      agentName: schema.agentChannels.agentName,
      channelId: schema.agentChannels.channelId
    })
    .from(schema.agentChannels)
    .where(inArray(schema.agentChannels.agentName, agentNames));
}

/** Insert a new agent row. Caller is responsible for uniqueness checks. */
export async function registerAgent(
  db: Db,
  input: RegisterAgentInput
): Promise<AgentRow> {
  const rows = await db
    .insert(schema.agents)
    .values({
      name: input.name,
      kind: input.kind,
      displayName: input.displayName ?? null,
      a2aEndpoint: input.a2aEndpoint,
      workspaceId: input.workspaceId,
      cardSigningJku: input.cardSigningJku ?? null,
      cardSigningKid: input.cardSigningKid ?? null
    })
    .returning();
  return rows[0];
}

/** Update mutable fields of an agent. Only provided patch fields are written. */
export async function updateAgent(
  db: Db,
  name: string,
  patch: UpdateAgentPatch
): Promise<AgentRow | null> {
  const rows = await db
    .update(schema.agents)
    .set({
      ...(patch.displayName !== undefined
        ? { displayName: patch.displayName }
        : {}),
      ...(patch.a2aEndpoint !== undefined
        ? { a2aEndpoint: patch.a2aEndpoint }
        : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.cardSigningJku !== undefined
        ? { cardSigningJku: patch.cardSigningJku }
        : {}),
      ...(patch.cardSigningKid !== undefined
        ? { cardSigningKid: patch.cardSigningKid }
        : {}),
      updatedAt: sql`(unixepoch())`
    })
    .where(eq(schema.agents.name, name))
    .returning();
  return rows[0] ?? null;
}

/**
 * Delete an agent and its channel attachments. D1 does not reliably enforce
 * foreign keys at runtime, so the agent_channels cascade is explicit.
 */
export async function unregisterAgent(db: Db, name: string): Promise<void> {
  await db
    .delete(schema.agentChannels)
    .where(eq(schema.agentChannels.agentName, name));
  await db.delete(schema.agents).where(eq(schema.agents.name, name));
}

/** Attach an agent to a channel (idempotent). */
export async function attachAgentChannel(
  db: Db,
  input: { agentName: string; channelId: string; workspaceId: number | null }
): Promise<void> {
  await db
    .insert(schema.agentChannels)
    .values({
      agentName: input.agentName,
      channelId: input.channelId,
      workspaceId: input.workspaceId
    })
    .onConflictDoNothing();
}

/** Detach an agent from a channel. */
export async function detachAgentChannel(
  db: Db,
  agentName: string,
  channelId: string
): Promise<void> {
  await db
    .delete(schema.agentChannels)
    .where(
      and(
        eq(schema.agentChannels.agentName, agentName),
        eq(schema.agentChannels.channelId, channelId)
      )
    );
}
