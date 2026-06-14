import { eq } from "drizzle-orm";
import type { Db } from "../client";
import * as schema from "../schema";

export type AgentRow = typeof schema.agents.$inferSelect;

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

export async function getAgentForChannel(
  db: Db,
  channelId: string
): Promise<AgentRow | null> {
  const rows = await db
    .select({ agent: schema.agents })
    .from(schema.agentChannels)
    .innerJoin(
      schema.agents,
      eq(schema.agentChannels.agentName, schema.agents.name)
    )
    .where(eq(schema.agentChannels.channelId, channelId))
    .limit(1);
  return rows[0]?.agent ?? null;
}
