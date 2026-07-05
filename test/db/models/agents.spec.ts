import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  getAgent,
  listAgents,
  getAgentsForChannel,
  getAgentInChannel
} from "@/db/models/agents";

const db = getDb();

describe("agents", () => {
  it("migration seed: admin and onboarding agents exist", async () => {
    const admin = await getAgent("admin");
    expect(admin?.kind).toBe("admin");
    expect(admin?.displayName).toBe("Admin Agent");
    expect(admin?.enabled).toBe(true);
    expect(admin?.workspaceId).toBe(0);

    const onboarding = await getAgent("onboarding");
    expect(onboarding?.kind).toBe("onboarding");
    expect(onboarding?.displayName).toBe("Onboarding Agent");
  });

  it("listAgents returns at least the two seeded agents", async () => {
    const agents = await listAgents();
    const names = agents.map((a) => a.name);
    expect(names).toContain("admin");
    expect(names).toContain("onboarding");
  });

  it("resolves an agent for a mapped channel", async () => {
    // Insert a custom agent directly, then map it to a channel.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('custom-x', 'custom', 1, 'mention', 'https://example.com/custom-x', 0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO agent_channels (channel_id, agent_name) VALUES ('C_MAP', 'custom-x')"
    ).run();
    const all = await getAgentsForChannel("C_MAP");
    expect(all.map((e) => e.agent.name)).toContain("custom-x");
    expect(await getAgentInChannel("C_MAP", "custom-x")).not.toBeNull();
    expect(await getAgentInChannel("C_UNMAPPED", "custom-x")).toBeNull();
  });
});
