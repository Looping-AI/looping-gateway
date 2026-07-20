import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  getAgent,
  listAgents,
  getAgentsForChannel,
  getAgentInChannel,
  agentRenderIdentity
} from "@/db/models/agents";
import { upsertWorkspace } from "@/db/models/workspaces";
import {
  setAdminDisplayName,
  setAdminIconUrl
} from "@/db/models/workspace-configs";

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

describe("agentRenderIdentity", () => {
  it("layers the workspace's avatar and name onto the shared admin row", async () => {
    await upsertWorkspace({
      id: 21,
      name: "ws21",
      adminChannelId: "C_WS21_ADMIN"
    });
    await setAdminDisplayName(21, "Ops Bot");
    await setAdminIconUrl(21, "https://gw.example.com/icons/21/admin/aa.jpg");

    const admin = await getAgent("admin");
    expect(await agentRenderIdentity(admin!, "C_WS21_ADMIN")).toEqual({
      displayName: "Ops Bot",
      iconUrl: "https://gw.example.com/icons/21/admin/aa.jpg"
    });
  });

  it("keeps each workspace's admin identity independent", async () => {
    await upsertWorkspace({
      id: 22,
      name: "ws22",
      adminChannelId: "C_WS22_ADMIN"
    });
    await upsertWorkspace({
      id: 23,
      name: "ws23",
      adminChannelId: "C_WS23_ADMIN"
    });
    await setAdminIconUrl(22, "https://gw.example.com/icons/22/admin/bb.jpg");

    const admin = await getAgent("admin");
    // ws23 never generated one — it falls back to the registry row, not ws22's.
    expect(await agentRenderIdentity(admin!, "C_WS23_ADMIN")).toEqual({
      displayName: "Admin Agent",
      iconUrl: null
    });
  });

  it("uses the row as-is for a custom agent (its identity is not workspace-scoped)", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, display_name, icon_url, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('custom-y', 'custom', 'Custom Y', 'https://gw.example.com/icons/0/custom-y/cc.jpg', 1, 'mention', 'https://example.com/y', 0)"
    ).run();
    const agent = await getAgent("custom-y");
    expect(await agentRenderIdentity(agent!, "C_ANY")).toEqual({
      displayName: "Custom Y",
      iconUrl: "https://gw.example.com/icons/0/custom-y/cc.jpg"
    });
  });

  it("falls back to the machine name when an agent has no display name", async () => {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO agents (name, kind, enabled, notify_on, a2a_endpoint, workspace_id) VALUES ('custom-z', 'custom', 1, 'mention', 'https://example.com/z', 0)"
    ).run();
    const agent = await getAgent("custom-z");
    expect(await agentRenderIdentity(agent!, "C_ANY")).toEqual({
      displayName: "custom-z",
      iconUrl: null
    });
  });
});
