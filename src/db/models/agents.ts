import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

export type AgentRow = typeof schema.agents.$inferSelect;

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
