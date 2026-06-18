import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  getAgent,
  getAgentChannels,
  listAgentsForWorkspace,
  registerAgent,
  updateAgent,
  unregisterAgent,
  attachAgentChannel,
  detachAgentChannel
} from "@/db/models/agents";
import {
  createWorkspace,
  getWorkspace,
  ORG_WORKSPACE_ID
} from "@/db/models/workspaces";

const db = getDb(env);

describe("workspaces — createWorkspace", () => {
  it("allocates an id above the org sentinel and persists the row", async () => {
    const ws = await createWorkspace(db, { name: "crud-team-a" });
    expect(ws.id).toBeGreaterThan(ORG_WORKSPACE_ID);
    expect(ws.name).toBe("crud-team-a");
    expect(await getWorkspace(db, ws.id)).toMatchObject({
      name: "crud-team-a"
    });
  });

  it("allocates monotonically increasing ids", async () => {
    const a = await createWorkspace(db, { name: "crud-team-b" });
    const b = await createWorkspace(db, { name: "crud-team-c" });
    expect(b.id).toBeGreaterThan(a.id);
  });
});

describe("agents — registry CRUD", () => {
  it("registers, updates, and unregisters a custom agent", async () => {
    const ws = await createWorkspace(db, { name: "crud-agents-1" });
    const row = await registerAgent(db, {
      name: "crud-agent-1",
      kind: "custom",
      displayName: "Crud Agent 1",
      a2aEndpoint: "https://example.com/crud-1",
      workspaceId: ws.id
    });
    expect(row).toMatchObject({
      name: "crud-agent-1",
      kind: "custom",
      workspaceId: ws.id
    });
    expect(row.enabled).toBe(true);

    const updated = await updateAgent(db, "crud-agent-1", {
      displayName: "Renamed",
      enabled: false,
      a2aEndpoint: "https://example.com/a2a"
    });
    expect(updated).toMatchObject({
      displayName: "Renamed",
      enabled: false,
      a2aEndpoint: "https://example.com/a2a"
    });

    await unregisterAgent(db, "crud-agent-1");
    expect(await getAgent(db, "crud-agent-1")).toBeNull();
  });

  it("listAgentsForWorkspace scopes by workspace", async () => {
    const wsA = await createWorkspace(db, { name: "crud-scope-a" });
    const wsB = await createWorkspace(db, { name: "crud-scope-b" });
    await registerAgent(db, {
      name: "crud-agent-scoped",
      kind: "custom",
      a2aEndpoint: "https://example.com/crud-scoped",
      workspaceId: wsA.id
    });
    const inA = await listAgentsForWorkspace(db, wsA.id);
    expect(inA.map((a) => a.name)).toContain("crud-agent-scoped");
    const inB = await listAgentsForWorkspace(db, wsB.id);
    expect(inB.map((a) => a.name)).not.toContain("crud-agent-scoped");
  });

  it("attach/detach channels and cascade on unregister", async () => {
    const ws = await createWorkspace(db, { name: "crud-channels" });
    await registerAgent(db, {
      name: "crud-agent-ch",
      kind: "custom",
      a2aEndpoint: "https://example.com/crud-ch",
      workspaceId: ws.id
    });
    await attachAgentChannel(db, {
      agentName: "crud-agent-ch",
      channelId: "C_CRUD",
      workspaceId: ws.id
    });
    // idempotent
    await attachAgentChannel(db, {
      agentName: "crud-agent-ch",
      channelId: "C_CRUD",
      workspaceId: ws.id
    });
    expect(await getAgentChannels(db, "crud-agent-ch")).toEqual(["C_CRUD"]);

    await detachAgentChannel(db, "crud-agent-ch", "C_CRUD");
    expect(await getAgentChannels(db, "crud-agent-ch")).toEqual([]);

    // re-attach, then unregister should remove channel rows too
    await attachAgentChannel(db, {
      agentName: "crud-agent-ch",
      channelId: "C_CRUD2",
      workspaceId: ws.id
    });
    await unregisterAgent(db, "crud-agent-ch");
    expect(await getAgentChannels(db, "crud-agent-ch")).toEqual([]);
  });
});
