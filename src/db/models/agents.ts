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

/** All agents configured for a channel (for the no-::name default path). */
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
    .where(eq(schema.agentChannels.channelId, channelId));
  return rows;
}

/** Check if a specific agent is configured for a channel (for the ::name validation path). */
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
        eq(schema.agentChannels.agentName, agentName)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}
