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
    "INSERT OR IGNORE INTO agents (name, kind, enabled, a2a_endpoint) VALUES ('off','custom',0,'https://example.com/off')"
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

describe("resolveTarget — built-in routing (no ::name)", () => {
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
    expect(t.userMessage).toMatch(/::weather/);
    expect(t.userMessage).toMatch(/::sales/);
  });

  it("returns none for an unconfigured channel", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_NOWHERE",
      text: "anyone?"
    });
    expect(t.kind).toBe("none");
  });
});

describe("resolveTarget — ::name refs (channel guard)", () => {
  it("::admin in an admin channel routes to admin", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_ORGADMIN",
      text: "<@UBOT> ::admin list agents"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("admin");
    expect(t.text).toBe("list agents");
  });

  it("::admin in a non-admin channel returns none with userMessage", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "::admin hi"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toMatch(/admin channel/);
  });

  it("::onboarding in a DM routes to onboarding and strips the ref", async () => {
    const t = await resolveTarget(db, {
      channelId: "D1",
      text: "::onboarding help me out"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("onboarding");
    expect(t.text).toBe("help me out");
  });

  it("::onboarding in a non-DM channel returns none with userMessage", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "<@UBOT> ::onboarding help"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toMatch(/direct messages/);
  });

  it("::weather in C_WEATHER (allowlisted) routes to weather", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_WEATHER",
      text: "::weather what is the forecast?"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("weather");
    expect(t.text).toBe("what is the forecast?");
  });

  it("::weather in C_MULTI (allowlisted) routes to weather", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_MULTI",
      text: "::weather forecast"
    });
    expect(t.kind).toBe("agent");
    if (t.kind !== "agent") return;
    expect(t.agent.name).toBe("weather");
  });

  it("::weather in C_RANDOM (not allowlisted) returns none with userMessage", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "::weather hi"
    });
    expect(t.kind).toBe("none");
    if (t.kind !== "none") return;
    expect(t.userMessage).toMatch(/not configured/);
  });

  it("returns none for an unknown ::name", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_RANDOM",
      text: "::nope hi"
    });
    expect(t.kind).toBe("none");
  });

  it("returns none for a disabled ::name", async () => {
    const t = await resolveTarget(db, {
      channelId: "C_WEATHER",
      text: "::off hi"
    });
    expect(t.kind).toBe("none");
  });
});
