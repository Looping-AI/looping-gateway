import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { resolveTarget } from "@/router/resolve";
import {
  setWorkspaceAdminChannel,
  upsertWorkspace
} from "@/db/models/workspaces";

const db = getDb(env);

beforeEach(async () => {
  // Org (ws 0) admin channel + a second workspace.
  await setWorkspaceAdminChannel(db, 0, "C_ORGADMIN");
  await upsertWorkspace(db, {
    id: 1,
    name: "ws1",
    adminChannelId: "C_WS1ADMIN"
  });

  // Custom agents in agent_channels.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint) VALUES ('weather','custom',1,0,'https://example.com/weather')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint) VALUES ('sales','custom',1,0,'https://example.com/sales')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agents (name, kind, enabled, workspace_id, a2a_endpoint) VALUES ('off','custom',0,0,'https://example.com/off')"
  ).run();

  // C_WEATHER → weather only.
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_WEATHER','weather')"
  ).run();
  // C_MULTI → weather + sales (two agents).
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_MULTI','weather')"
  ).run();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO agent_channels (channel_id, agent_name) VALUES ('C_MULTI','sales')"
  ).run();
});

describe("resolveTarget — built-in routing (no agent name mention)", () => {
  it("routes an org admin channel to the admin agent (workspace 0)", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_ORGADMIN",
      text: "<@UBOT> list agents"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("admin");
    expect(t.workspaceId).toBe(0);
  });

  it("scopes the admin agent to the channel's workspace", async () => {
    const t = await resolveTarget(db, { channelId: "C_WS1ADMIN", text: "hi" });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("admin");
    expect(t.workspaceId).toBe(1);
  });

  it("routes a DM to the onboarding agent", async () => {
    const t = await resolveTarget(db, { channelId: "D999", text: "hello" });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("onboarding");
  });

  it("routes an allowlisted channel with one agent to that agent", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_WEATHER",
      text: "forecast"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("weather");
  });

  it("returns none with userMessage when channel has multiple agents", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_MULTI",
      text: "help"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toMatch(/`weather`/);
    expect(t.userMessage).toMatch(/`sales`/);
    expect(t.userMessage).not.toMatch(/:{2}/);
  });

  it("returns none for an unconfigured channel", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_NOWHERE",
      text: "anyone?"
    });
    expect(t.kind).toBe("none");
  });
});

describe("resolveTarget — name mentions (channel guard)", () => {
  it("admin in an admin channel routes to admin", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_ORGADMIN",
      text: "<@UBOT> admin list agents"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("admin");
    expect(t.text).toBe("<@UBOT> admin list agents");
  });

  it("admin in a non-admin channel does not route by mention", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "admin hi"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toBeUndefined();
  });

  it("onboarding in a DM routes to onboarding and keeps the name", async () => {
    const t = await resolveTarget(db, {
      channelId: "D1",
      text: "onboarding help me out"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("onboarding");
    expect(t.text).toBe("onboarding help me out");
  });

  it("onboarding in a non-DM channel does not route by mention", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "<@UBOT> onboarding help"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toBeUndefined();
  });

  it("weather in C_WEATHER (allowlisted) routes to weather", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_WEATHER",
      text: "weather what is the forecast?"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("weather");
    expect(t.text).toBe("weather what is the forecast?");
  });

  it("weather in C_MULTI (allowlisted) routes to weather", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_MULTI",
      text: "weather forecast"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("weather");
  });

  it("weather in C_RANDOM (not allowlisted) does not route by mention", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "weather hi"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toBeUndefined();
  });

  it("returns none for an unknown name in an unconfigured channel", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "nope hi"
    });
    expect(t.kind).toBe("none");
  });

  it("ignores disabled names when matching explicit mentions", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_MULTI",
      text: "off hi"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toMatch(/Multiple agents/);
  });
});
