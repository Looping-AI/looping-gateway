import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import type { UserAuthContext } from "@/auth";
import {
  directoryAgents,
  directoryWorkspaces,
  directoryHealth,
  buildOnboardingTools,
  type OnboardingToolDeps
} from "@/agents/onboarding/tools";
import { createWorkspace } from "@/db/models/workspaces";
import { registerAgent, updateAgent } from "@/db/models/agents";
import { upsertSlackUser } from "@/db/models/users";

const db = getDb(env);

async function freshWsId(name: string): Promise<number> {
  return (await createWorkspace(db, { name })).id;
}

function ctx(overrides: Partial<UserAuthContext> = {}): UserAuthContext {
  return {
    slackUserId: "U_onb",
    displayName: "Newbie",
    isPrimaryOwner: false,
    isOrgAdmin: false,
    adminWorkspaces: [],
    ...overrides
  };
}

function deps(c: UserAuthContext | null): OnboardingToolDeps {
  return { db, ctx: c };
}

type AgentList = { agents: Array<{ name: string; kind: string }> };
type WsList = {
  workspaces: Array<{ id: number; adminChannelConfigured: boolean }>;
};

describe("onboarding tools — directory_read agents", () => {
  it("shows built-ins plus the caller's own workspace agents, hiding others'", async () => {
    const mine = await freshWsId("onb-mine");
    const other = await freshWsId("onb-other");
    await registerAgent(db, {
      name: "onb-mine-agent",
      kind: "custom",
      a2aEndpoint: "https://example.com/onb-mine",
      workspaceId: mine
    });
    await registerAgent(db, {
      name: "onb-other-agent",
      kind: "custom",
      a2aEndpoint: "https://example.com/onb-other",
      workspaceId: other
    });

    const res = (await directoryAgents(
      deps(ctx({ adminWorkspaces: [mine] }))
    )) as AgentList;
    const names = res.agents.map((a) => a.name);

    // Built-in concierge/admin are always reachable.
    expect(names).toContain("admin");
    expect(names).toContain("onboarding");
    // Own-workspace custom agent visible; another workspace's hidden.
    expect(names).toContain("onb-mine-agent");
    expect(names).not.toContain("onb-other-agent");
  });

  it("hides disabled agents", async () => {
    const wsId = await freshWsId("onb-disabled");
    await registerAgent(db, {
      name: "onb-disabled-agent",
      kind: "custom",
      a2aEndpoint: "https://example.com/onb-disabled",
      workspaceId: wsId
    });
    await updateAgent(db, "onb-disabled-agent", { enabled: false });

    const res = (await directoryAgents(
      deps(ctx({ adminWorkspaces: [wsId] }))
    )) as AgentList;
    expect(res.agents.map((a) => a.name)).not.toContain("onb-disabled-agent");
  });
});

describe("onboarding tools — directory_read workspaces", () => {
  it("returns only the workspaces the caller administers", async () => {
    const a = await freshWsId("onb-ws-a");
    await freshWsId("onb-ws-b");
    const res = (await directoryWorkspaces(
      deps(ctx({ adminWorkspaces: [a] }))
    )) as WsList;
    expect(res.workspaces.map((w) => w.id)).toEqual([a]);
  });

  it("returns nothing for an unauthenticated caller", async () => {
    const res = (await directoryWorkspaces(deps(null))) as WsList;
    expect(res.workspaces).toHaveLength(0);
  });

  it("an org admin sees every workspace", async () => {
    const created = await freshWsId("onb-ws-org");
    const res = (await directoryWorkspaces(
      deps(ctx({ isOrgAdmin: true }))
    )) as WsList;
    expect(res.workspaces.map((w) => w.id)).toContain(created);
  });
});

describe("onboarding tools — directory_read health", () => {
  it("reports a registered user and admin-channel status", async () => {
    const wsId = (
      await createWorkspace(db, {
        name: "onb-health-ws",
        adminChannelId: "C_HEALTH"
      })
    ).id;
    await upsertSlackUser(db, {
      slackUserId: "U_health",
      displayName: "Healthy"
    });

    const res = (await directoryHealth(
      deps(ctx({ slackUserId: "U_health", adminWorkspaces: [wsId] }))
    )) as {
      registered: boolean;
      enabledAgentCount: number;
      administersWorkspaces: Array<{ adminChannelConfigured: boolean }>;
    };

    expect(res.registered).toBe(true);
    expect(res.enabledAgentCount).toBeGreaterThanOrEqual(2);
    expect(res.administersWorkspaces[0].adminChannelConfigured).toBe(true);
  });

  it("reports an unregistered user with a reconcile note", async () => {
    const res = (await directoryHealth(
      deps(ctx({ slackUserId: "U_never_seen" }))
    )) as { registered: boolean; note?: string };
    expect(res.registered).toBe(false);
    expect(res.note).toMatch(/sync|reconcile/i);
  });
});

describe("onboarding tools — buildOnboardingTools", () => {
  it("exposes exactly the read-only directory_read tool", () => {
    const tools = buildOnboardingTools(deps(ctx()));
    expect(Object.keys(tools)).toEqual(["directory_read"]);
  });
});
