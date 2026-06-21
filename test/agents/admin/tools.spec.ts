import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import type { UserAuthContext } from "@/auth";
import {
  agentsRead,
  agentsWrite,
  workspaceRead,
  workspaceWrite,
  buildAdminTools,
  type AdminToolDeps
} from "@/agents/admin/tools";
import { ORG_WORKSPACE_ID, createWorkspace } from "@/db/models/workspaces";
import { getAgent } from "@/db/models/agents";

const db = getDb(env);

/** Create a real workspace (agents FK-reference it) and return its id. */
async function freshWsId(name: string): Promise<number> {
  return (await createWorkspace(db, { name })).id;
}

function ctx(overrides: Partial<UserAuthContext> = {}): UserAuthContext {
  return {
    slackUserId: "U1",
    displayName: "Tester",
    isPrimaryOwner: false,
    isOrgAdmin: false,
    adminWorkspaces: [],
    ...overrides
  };
}

const orgAdmin = ctx({ isOrgAdmin: true });

function deps(wsId: number, c: UserAuthContext | null): AdminToolDeps {
  return {
    db,
    ctx: c,
    wsId,
    // Offline stub: pretend every endpoint serves a validly-signed card.
    verifyEndpoint: async (endpoint) => ({
      cardSigningJku: `${new URL(endpoint).origin}/.well-known/jwks.json`,
      cardSigningKid: "test-kid"
    })
  };
}

describe("admin tools — agents_write / agents_read", () => {
  it("registers a custom agent scoped to the workspace and reads it back", async () => {
    const wsId = await freshWsId("tools-ws-a");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    const reg = await agentsWrite(d, {
      operation: "register",
      name: "tool-agent-a",
      displayName: "Tool Agent A",
      a2aEndpoint: "https://example.com/tool-agent-a"
    });
    expect(reg).toMatchObject({ ok: true });

    const read = (await agentsRead(d, { name: "tool-agent-a" })) as {
      agents: Array<{ name: string; kind: string; workspaceId: number }>;
    };
    expect(read.agents).toHaveLength(1);
    expect(read.agents[0]).toMatchObject({
      name: "tool-agent-a",
      kind: "custom",
      workspaceId: wsId
    });
  });

  it("denies a caller who is not an admin of the workspace", async () => {
    const d = deps(101, ctx({ adminWorkspaces: [999] }));
    expect(await agentsRead(d, {})).toHaveProperty("error");
    expect(
      await agentsWrite(d, {
        operation: "register",
        name: "nope",
        a2aEndpoint: "https://example.com/nope"
      })
    ).toHaveProperty("error");
  });

  it("denies when there is no authenticated caller", async () => {
    const d = deps(102, null);
    expect(await agentsRead(d, {})).toHaveProperty("error");
  });

  it("refuses reserved/built-in names and duplicates", async () => {
    const d = deps(ORG_WORKSPACE_ID, orgAdmin);
    expect(
      await agentsWrite(d, {
        operation: "register",
        name: "admin",
        a2aEndpoint: "https://example.com/admin"
      })
    ).toHaveProperty("error");
    // built-in admin row cannot be modified
    expect(
      await agentsWrite(d, { operation: "unregister", name: "admin" })
    ).toHaveProperty("error");

    const wsId = await freshWsId("tools-ws-dup");
    const d2 = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsWrite(d2, {
      operation: "register",
      name: "dup-agent",
      a2aEndpoint: "https://example.com/dup-agent"
    });
    expect(
      await agentsWrite(d2, {
        operation: "register",
        name: "dup-agent",
        a2aEndpoint: "https://example.com/dup-agent"
      })
    ).toHaveProperty("error");
  });

  it("update attaches and detaches channels", async () => {
    const wsId = await freshWsId("tools-ws-chan");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsWrite(d, {
      operation: "register",
      name: "chan-agent",
      a2aEndpoint: "https://example.com/chan-agent"
    });
    await agentsWrite(d, {
      operation: "update",
      name: "chan-agent",
      displayName: "Channeled",
      attachChannels: ["C_A", "C_B"]
    });
    const afterAttach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ displayName: string; channels: string[] }>;
    };
    expect(afterAttach.agents[0].displayName).toBe("Channeled");
    expect(afterAttach.agents[0].channels.sort()).toEqual(["C_A", "C_B"]);

    await agentsWrite(d, {
      operation: "update",
      name: "chan-agent",
      detachChannels: ["C_A"]
    });
    const afterDetach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ channels: string[] }>;
    };
    expect(afterDetach.agents[0].channels).toEqual(["C_B"]);
  });

  it("cannot write to an agent in another workspace", async () => {
    const wsA = await freshWsId("tools-ws-owner");
    const wsB = await freshWsId("tools-ws-other");
    const owner = deps(wsA, ctx({ adminWorkspaces: [wsA] }));
    await agentsWrite(owner, {
      operation: "register",
      name: "wsA-agent",
      a2aEndpoint: "https://example.com/wsA-agent"
    });
    const other = deps(wsB, ctx({ adminWorkspaces: [wsB] }));
    expect(
      await agentsWrite(other, { operation: "unregister", name: "wsA-agent" })
    ).toHaveProperty("error");
  });
});

describe("admin tools — card-signing verification + pin (TOFU)", () => {
  /** deps with an explicit endpoint verifier (signed-card check seam). */
  function depsWith(
    wsId: number,
    c: UserAuthContext | null,
    verifyEndpoint: AdminToolDeps["verifyEndpoint"]
  ): AdminToolDeps {
    return { db, ctx: c, wsId, verifyEndpoint };
  }

  it("persists the verified signing pin on register", async () => {
    const wsId = await freshWsId("tools-ws-pin");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      cardSigningJku: "https://signed.example.com/.well-known/jwks.json",
      cardSigningKid: "pin-kid-1"
    }));
    const reg = await agentsWrite(d, {
      operation: "register",
      name: "pinned-agent",
      a2aEndpoint: "https://signed.example.com/a2a"
    });
    expect(reg).toMatchObject({ ok: true });

    const row = await getAgent(db, "pinned-agent");
    expect(row?.cardSigningJku).toBe(
      "https://signed.example.com/.well-known/jwks.json"
    );
    expect(row?.cardSigningKid).toBe("pin-kid-1");
  });

  it("rejects registration when card verification fails (unsigned/forged)", async () => {
    const wsId = await freshWsId("tools-ws-unsigned");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => {
      throw new Error("AgentCard is not signed");
    });
    const res = await agentsWrite(d, {
      operation: "register",
      name: "unsigned-agent",
      a2aEndpoint: "https://unsigned.example.com/a2a"
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("verification failed");
    expect(await getAgent(db, "unsigned-agent")).toBeNull();
  });

  it("rejects re-pointing to an endpoint signed by a different key (TOFU)", async () => {
    const wsId = await freshWsId("tools-ws-tofu");
    const original = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async () => ({
        cardSigningJku: "https://a.example.com/.well-known/jwks.json",
        cardSigningKid: "key-A"
      })
    );
    await agentsWrite(original, {
      operation: "register",
      name: "tofu-agent",
      a2aEndpoint: "https://a.example.com/a2a"
    });

    // A new endpoint that verifies — but with a DIFFERENT pinned identity.
    const repointed = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async () => ({
        cardSigningJku: "https://b.example.com/.well-known/jwks.json",
        cardSigningKid: "key-B"
      })
    );
    const res = await agentsWrite(repointed, {
      operation: "update",
      name: "tofu-agent",
      a2aEndpoint: "https://b.example.com/a2a"
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("different key");

    // The original pin and endpoint are unchanged.
    const row = await getAgent(db, "tofu-agent");
    expect(row?.cardSigningKid).toBe("key-A");
    expect(row?.a2aEndpoint).toBe("https://a.example.com/a2a");
  });

  it("allows re-pointing to a new endpoint with the SAME pinned key", async () => {
    const wsId = await freshWsId("tools-ws-tofu-ok");
    const pin = {
      cardSigningJku: "https://same.example.com/.well-known/jwks.json",
      cardSigningKid: "key-same"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => pin);
    await agentsWrite(d, {
      operation: "register",
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/a2a"
    });
    const res = await agentsWrite(d, {
      operation: "update",
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/v2"
    });
    expect(res).toMatchObject({ ok: true });
    const row = await getAgent(db, "tofu-ok-agent");
    expect(row?.a2aEndpoint).toBe("https://same.example.com/v2");
  });
});

describe("admin tools — workspace_write instance scoping", () => {
  it("org instance (wsId 0) with org admin can create a workspace", async () => {
    const d = deps(ORG_WORKSPACE_ID, orgAdmin);
    const res = (await workspaceWrite(d, {
      operation: "create",
      name: "tools-created-ws"
    })) as { ok?: boolean; workspace?: { id: number } };
    expect(res.ok).toBe(true);
    expect(res.workspace?.id).toBeGreaterThan(ORG_WORKSPACE_ID);
  });

  it("workspace instance (wsId != 0) is denied even for an org admin", async () => {
    const d = deps(107, orgAdmin);
    expect(
      await workspaceWrite(d, { operation: "create", name: "should-fail" })
    ).toHaveProperty("error");
  });

  it("org instance denies a non-org caller", async () => {
    const d = deps(ORG_WORKSPACE_ID, ctx({ adminWorkspaces: [5] }));
    expect(
      await workspaceWrite(d, { operation: "create", name: "should-fail" })
    ).toHaveProperty("error");
  });
});

describe("admin tools — buildAdminTools availability", () => {
  it("exposes workspace_write only on the org instance", () => {
    const orgTools = buildAdminTools(deps(ORG_WORKSPACE_ID, orgAdmin));
    expect(Object.keys(orgTools)).toContain("workspace_write");

    const wsTools = buildAdminTools(deps(3, ctx({ adminWorkspaces: [3] })));
    expect(Object.keys(wsTools)).not.toContain("workspace_write");
    expect(Object.keys(wsTools)).toEqual(
      expect.arrayContaining(["agents_read", "agents_write", "workspace_read"])
    );
  });
});

describe("admin tools — workspace_read scoping", () => {
  it("a workspace admin reads only its own workspace", async () => {
    const d = deps(2, ctx({ adminWorkspaces: [2] }));
    const denied = await workspaceRead(d, { id: 999 });
    expect(denied).toHaveProperty("error");
  });
});
