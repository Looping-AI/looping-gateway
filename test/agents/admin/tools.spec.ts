import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import type { UserAuthContext } from "@/auth";
import {
  agentsRead,
  agentsWrite,
  workspaceRead,
  workspaceWrite,
  remoteAgentDomains,
  selfWrite,
  buildAdminTools,
  type AdminToolDeps
} from "@/agents/admin/tools";
import { ORG_WORKSPACE_ID, createWorkspace } from "@/db/models/workspaces";
import { getAgent } from "@/db/models/agents";
import {
  setPublicUrl,
  getAdminIconUrl,
  getAdminDisplayName
} from "@/db/models/workspace-configs";

const db = getDb();

/** Create a real workspace (agents FK-reference it) and return its id. */
async function freshWsId(name: string): Promise<number> {
  return (await createWorkspace({ name })).id;
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
    ctx: c,
    wsId,
    // Offline stub: pretend every endpoint serves a validly-signed card.
    verifyEndpoint: async (endpoint) => ({
      pin: {
        cardSigningJku: `${new URL(endpoint).origin}/.well-known/jwks.json`,
        cardSigningKid: "test-kid"
      },
      displayName: "Stubbed Agent"
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
      a2aEndpoint: "https://example.com/tool-agent-a",
      notifyOn: "mention"
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
        a2aEndpoint: "https://example.com/nope",
        notifyOn: "mention"
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
        a2aEndpoint: "https://example.com/admin",
        notifyOn: "mention"
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
      a2aEndpoint: "https://example.com/dup-agent",
      notifyOn: "mention"
    });
    expect(
      await agentsWrite(d2, {
        operation: "register",
        name: "dup-agent",
        a2aEndpoint: "https://example.com/dup-agent",
        notifyOn: "mention"
      })
    ).toHaveProperty("error");
  });

  it("adds and removes channels one at a time", async () => {
    const wsId = await freshWsId("tools-ws-chan");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await agentsWrite(d, {
      operation: "register",
      name: "chan-agent",
      a2aEndpoint: "https://example.com/chan-agent",
      notifyOn: "mention"
    });
    await agentsWrite(d, {
      operation: "update",
      name: "chan-agent",
      displayName: "Channeled"
    });
    await agentsWrite(d, {
      operation: "add_channel",
      name: "chan-agent",
      channelId: "C_A"
    });
    await agentsWrite(d, {
      operation: "add_channel",
      name: "chan-agent",
      channelId: "C_B"
    });
    const afterAttach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ displayName: string; channels: string[] }>;
    };
    expect(afterAttach.agents[0].displayName).toBe("Channeled");
    expect(afterAttach.agents[0].channels.sort()).toEqual(["C_A", "C_B"]);

    await agentsWrite(d, {
      operation: "remove_channel",
      name: "chan-agent",
      channelId: "C_A"
    });
    const afterDetach = (await agentsRead(d, { name: "chan-agent" })) as {
      agents: Array<{ channels: string[] }>;
    };
    expect(afterDetach.agents[0].channels).toEqual(["C_B"]);
  });

  it("rejects channel ops on built-in / cross-workspace agents", async () => {
    const wsA = await freshWsId("tools-ws-chan-owner");
    const wsB = await freshWsId("tools-ws-chan-other");
    const owner = deps(wsA, ctx({ adminWorkspaces: [wsA] }));
    await agentsWrite(owner, {
      operation: "register",
      name: "chan-owned",
      a2aEndpoint: "https://example.com/chan-owned",
      notifyOn: "mention"
    });
    const other = deps(wsB, ctx({ adminWorkspaces: [wsB] }));
    expect(
      await agentsWrite(other, {
        operation: "add_channel",
        name: "chan-owned",
        channelId: "C_X"
      })
    ).toHaveProperty("error");
    expect(
      await agentsWrite(owner, {
        operation: "remove_channel",
        name: "admin",
        channelId: "C_X"
      })
    ).toHaveProperty("error");
  });

  it("cannot write to an agent in another workspace", async () => {
    const wsA = await freshWsId("tools-ws-owner");
    const wsB = await freshWsId("tools-ws-other");
    const owner = deps(wsA, ctx({ adminWorkspaces: [wsA] }));
    await agentsWrite(owner, {
      operation: "register",
      name: "wsa-agent",
      a2aEndpoint: "https://example.com/wsa-agent",
      notifyOn: "mention"
    });
    const other = deps(wsB, ctx({ adminWorkspaces: [wsB] }));
    expect(
      await agentsWrite(other, { operation: "unregister", name: "wsa-agent" })
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
    return { ctx: c, wsId, verifyEndpoint };
  }

  it("persists the verified signing pin on register", async () => {
    const wsId = await freshWsId("tools-ws-pin");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin: {
        cardSigningJku: "https://signed.example.com/.well-known/jwks.json",
        cardSigningKid: "pin-kid-1"
      },
      displayName: "Pinned Agent"
    }));
    const reg = await agentsWrite(d, {
      operation: "register",
      name: "pinned-agent",
      a2aEndpoint: "https://signed.example.com/a2a",
      notifyOn: "mention"
    });
    expect(reg).toMatchObject({ ok: true });

    const row = await getAgent("pinned-agent");
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
      a2aEndpoint: "https://unsigned.example.com/a2a",
      notifyOn: "mention"
    });
    expect(res).toHaveProperty("error");
    expect((res as { error: string }).error).toContain("verification failed");
    expect(await getAgent("unsigned-agent")).toBeNull();
  });

  it("rejects re-pointing to an endpoint signed by a different key (TOFU)", async () => {
    const wsId = await freshWsId("tools-ws-tofu");
    const original = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async () => ({
        pin: {
          cardSigningJku: "https://a.example.com/.well-known/jwks.json",
          cardSigningKid: "key-A"
        },
        displayName: "Agent A"
      })
    );
    await agentsWrite(original, {
      operation: "register",
      name: "tofu-agent",
      a2aEndpoint: "https://a.example.com/a2a",
      notifyOn: "mention"
    });

    // A new endpoint that verifies — but with a DIFFERENT pinned identity.
    const repointed = depsWith(
      wsId,
      ctx({ adminWorkspaces: [wsId] }),
      async () => ({
        pin: {
          cardSigningJku: "https://b.example.com/.well-known/jwks.json",
          cardSigningKid: "key-B"
        },
        displayName: "Agent B"
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
    const row = await getAgent("tofu-agent");
    expect(row?.cardSigningKid).toBe("key-A");
    expect(row?.a2aEndpoint).toBe("https://a.example.com/a2a");
  });

  it("allows re-pointing to a new endpoint with the SAME pinned key", async () => {
    const wsId = await freshWsId("tools-ws-tofu-ok");
    const pin = {
      cardSigningJku: "https://same.example.com/.well-known/jwks.json",
      cardSigningKid: "key-same"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin,
      displayName: "Same Agent"
    }));
    await agentsWrite(d, {
      operation: "register",
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/a2a",
      notifyOn: "mention"
    });
    const res = await agentsWrite(d, {
      operation: "update",
      name: "tofu-ok-agent",
      a2aEndpoint: "https://same.example.com/v2"
    });
    expect(res).toMatchObject({ ok: true });
    const row = await getAgent("tofu-ok-agent");
    expect(row?.a2aEndpoint).toBe("https://same.example.com/v2");
  });
});

describe("admin tools — derive displayName from card (iconUrl is never card-sourced)", () => {
  function depsWith(
    wsId: number,
    c: UserAuthContext | null,
    verifyEndpoint: AdminToolDeps["verifyEndpoint"]
  ): AdminToolDeps {
    return { ctx: c, wsId, verifyEndpoint };
  }

  it("uses card name as displayName and leaves iconUrl unset at register", async () => {
    const wsId = await freshWsId("tools-ws-derive-a");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin: {
        cardSigningJku: "https://derive.example.com/.well-known/jwks.json",
        cardSigningKid: "k1"
      },
      displayName: "From Card"
    }));
    await agentsWrite(d, {
      operation: "register",
      name: "derive-agent",
      a2aEndpoint: "https://derive.example.com/a2a",
      notifyOn: "mention"
    });
    const row = await getAgent("derive-agent");
    expect(row?.displayName).toBe("From Card");
    // A custom agent has no avatar until the admin generates one.
    expect(row?.iconUrl).toBeNull();
  });

  it("explicit displayName at register overrides the card name", async () => {
    const wsId = await freshWsId("tools-ws-derive-b");
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin: {
        cardSigningJku: "https://derive2.example.com/.well-known/jwks.json",
        cardSigningKid: "k2"
      },
      displayName: "From Card"
    }));
    await agentsWrite(d, {
      operation: "register",
      name: "derive-override-agent",
      displayName: "My Override",
      a2aEndpoint: "https://derive2.example.com/a2a",
      notifyOn: "mention"
    });
    const row = await getAgent("derive-override-agent");
    expect(row?.displayName).toBe("My Override");
  });

  it("endpoint update re-derives displayName but never touches iconUrl", async () => {
    const wsId = await freshWsId("tools-ws-derive-c");
    const pin = {
      cardSigningJku: "https://rederive.example.com/.well-known/jwks.json",
      cardSigningKid: "k3"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin,
      displayName: "New Card Name"
    }));
    await agentsWrite(d, {
      operation: "register",
      name: "rederive-agent",
      a2aEndpoint: "https://rederive.example.com/v1",
      notifyOn: "mention"
    });
    // Give the agent a gateway-hosted avatar, then re-point the endpoint.
    const withSeams: AdminToolDeps = {
      ...d,
      generateImage: async () => ({
        data: new Uint8Array([9, 9, 9]),
        contentType: "image/jpeg"
      }),
      storeIcon: async () => ({
        key: "deadbeefdeadbeef",
        contentType: "image/jpeg"
      })
    };
    await setPublicUrl("https://gw.example.com");
    await agentsWrite(withSeams, {
      operation: "regenerate_avatar",
      name: "rederive-agent"
    });
    const generated = (await getAgent("rederive-agent"))?.iconUrl;
    expect(generated).toBe(
      `https://gw.example.com/icons/${wsId}/rederive-agent/deadbeefdeadbeef.jpg`
    );

    await agentsWrite(d, {
      operation: "update",
      name: "rederive-agent",
      a2aEndpoint: "https://rederive.example.com/v2"
    });
    const row = await getAgent("rederive-agent");
    expect(row?.a2aEndpoint).toBe("https://rederive.example.com/v2");
    expect(row?.displayName).toBe("New Card Name");
    // The admin-generated avatar survives the endpoint change.
    expect(row?.iconUrl).toBe(generated);
  });

  it("explicit displayName on endpoint update overrides re-derived card name", async () => {
    const wsId = await freshWsId("tools-ws-derive-d");
    const pin = {
      cardSigningJku: "https://override2.example.com/.well-known/jwks.json",
      cardSigningKid: "k4"
    };
    const d = depsWith(wsId, ctx({ adminWorkspaces: [wsId] }), async () => ({
      pin,
      displayName: "Card Name"
    }));
    await agentsWrite(d, {
      operation: "register",
      name: "override2-agent",
      a2aEndpoint: "https://override2.example.com/v1",
      notifyOn: "mention"
    });
    await agentsWrite(d, {
      operation: "update",
      name: "override2-agent",
      a2aEndpoint: "https://override2.example.com/v2",
      displayName: "Manual Override"
    });
    const row = await getAgent("override2-agent");
    expect(row?.displayName).toBe("Manual Override");
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
  it("exposes workspace_write and remote_agent_domains only on the org instance", () => {
    const orgTools = buildAdminTools(deps(ORG_WORKSPACE_ID, orgAdmin));
    expect(Object.keys(orgTools)).toContain("workspace_write");
    expect(Object.keys(orgTools)).toContain("remote_agent_domains");

    const wsTools = buildAdminTools(deps(3, ctx({ adminWorkspaces: [3] })));
    expect(Object.keys(wsTools)).not.toContain("workspace_write");
    expect(Object.keys(wsTools)).not.toContain("remote_agent_domains");
    expect(Object.keys(wsTools)).toEqual(
      expect.arrayContaining(["agents_read", "agents_write", "workspace_read"])
    );
  });
});

describe("admin tools — remote_agent_domains", () => {
  const orgDeps = deps(ORG_WORKSPACE_ID, orgAdmin);

  it("lists empty approved domains initially", async () => {
    const res = (await remoteAgentDomains(orgDeps, { operation: "list" })) as {
      approvedDomains: string[];
    };
    expect(Array.isArray(res.approvedDomains)).toBe(true);
  });

  it("adds a domain and reads it back via list", async () => {
    await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "agents.example-radt.com"
    });
    const res = (await remoteAgentDomains(orgDeps, { operation: "list" })) as {
      approvedDomains: string[];
    };
    expect(res.approvedDomains).toContain("agents.example-radt.com");
  });

  it("is idempotent when adding the same domain twice", async () => {
    await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "idempotent.example-radt.com"
    });
    await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "idempotent.example-radt.com"
    });
    const res = (await remoteAgentDomains(orgDeps, { operation: "list" })) as {
      approvedDomains: string[];
    };
    const count = res.approvedDomains.filter(
      (d) => d === "idempotent.example-radt.com"
    ).length;
    expect(count).toBe(1);
  });

  it("removes a domain", async () => {
    await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "remove-me.example-radt.com"
    });
    await remoteAgentDomains(orgDeps, {
      operation: "remove",
      domain: "remove-me.example-radt.com"
    });
    const res = (await remoteAgentDomains(orgDeps, { operation: "list" })) as {
      approvedDomains: string[];
    };
    expect(res.approvedDomains).not.toContain("remove-me.example-radt.com");
  });

  it("remove is a no-op when domain is not in the list", async () => {
    const res = await remoteAgentDomains(orgDeps, {
      operation: "remove",
      domain: "never-added.example-radt.com"
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("rejects adding a bare shared-infra root domain", async () => {
    for (const root of ["workers.dev", "pages.dev", "vercel.app"]) {
      const res = (await remoteAgentDomains(orgDeps, {
        operation: "add",
        domain: root
      })) as { error: string };
      expect(res).toHaveProperty("error");
      expect(res.error).toContain("shared infrastructure root domain");
    }
  });

  it("allows adding an account-level subdomain of a shared-infra root", async () => {
    const res = await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "myorg.workers.dev"
    });
    expect(res).toMatchObject({ ok: true });
  });

  it("rejects a bare single-label domain", async () => {
    const res = await remoteAgentDomains(orgDeps, {
      operation: "add",
      domain: "localhost"
    });
    expect(res).toHaveProperty("error");
  });

  it("denies a non-org-admin caller", async () => {
    const nonOrg = deps(ORG_WORKSPACE_ID, ctx({ adminWorkspaces: [5] }));
    expect(
      await remoteAgentDomains(nonOrg, { operation: "list" })
    ).toHaveProperty("error");
  });

  it("denies calls from a non-org workspace instance", async () => {
    const wsInstance = deps(3, orgAdmin);
    expect(
      await remoteAgentDomains(wsInstance, { operation: "list" })
    ).toHaveProperty("error");
  });

  it("denies unauthenticated calls", async () => {
    const noAuth = deps(ORG_WORKSPACE_ID, null);
    expect(
      await remoteAgentDomains(noAuth, { operation: "list" })
    ).toHaveProperty("error");
  });
});

describe("admin tools — workspace_read scoping", () => {
  it("a workspace admin reads only its own workspace", async () => {
    const d = deps(2, ctx({ adminWorkspaces: [2] }));
    const denied = await workspaceRead(d, { id: 999 });
    expect(denied).toHaveProperty("error");
  });
});

const okImage = {
  data: new Uint8Array([1, 2, 3]),
  contentType: "image/jpeg"
};

/** Tool deps with the image/store seams wired to in-memory fakes. */
function avatarDeps(
  wsId: number,
  c: UserAuthContext | null,
  overrides: Partial<AdminToolDeps> = {}
): AdminToolDeps {
  return {
    ...deps(wsId, c),
    generateImage: async () => okImage,
    storeIcon: async () => ({
      key: "abc123def4567890",
      contentType: "image/jpeg"
    }),
    ...overrides
  };
}

describe("admin tools — self_write set_avatar", () => {
  it("generates, stores under the 'admin' name, and records the avatar URL", async () => {
    const wsId = await freshWsId("tools-ws-avatar");
    await setPublicUrl("https://gw.example.com");
    const prompts: string[] = [];
    const names: string[] = [];
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async (p) => {
        prompts.push(p);
        return okImage;
      },
      storeIcon: async (_img, name) => {
        names.push(name);
        return { key: "abc123def4567890", contentType: "image/jpeg" };
      }
    });

    const res = (await selfWrite(d, {
      operation: "set_avatar",
      instructions: "blue robot"
    })) as { ok?: boolean; iconUrl?: string };
    expect(res.ok).toBe(true);
    expect(res.iconUrl).toBe(
      `https://gw.example.com/icons/${wsId}/admin/abc123def4567890.jpg`
    );
    expect(prompts[0]).toContain("tools-ws-avatar");
    expect(prompts[0]).toContain("blue robot");
    expect(names).toEqual(["admin"]);
    expect(await getAdminIconUrl(wsId)).toBe(res.iconUrl);
  });

  it("errors when the gateway public URL isn't known yet", async () => {
    const wsId = await freshWsId("tools-ws-avatar-nourl");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(await selfWrite(d, { operation: "set_avatar" })).toHaveProperty(
      "error"
    );
  });

  it("denies a caller who is not an admin of the workspace", async () => {
    const wsId = await freshWsId("tools-ws-avatar-deny");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [999] }));
    expect(await selfWrite(d, { operation: "set_avatar" })).toHaveProperty(
      "error"
    );
  });

  it("errors when the image seams are absent", async () => {
    const wsId = await freshWsId("tools-ws-avatar-noseam");
    await setPublicUrl("https://gw.example.com");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] })); // no generateImage/storeIcon
    const res = (await selfWrite(d, { operation: "set_avatar" })) as {
      error?: string;
    };
    expect(res.error).toContain("not available");
  });

  it("surfaces a friendly error when generation throws", async () => {
    const wsId = await freshWsId("tools-ws-avatar-fail");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async () => {
        throw new Error("model overloaded");
      }
    });
    const res = (await selfWrite(d, { operation: "set_avatar" })) as {
      error?: string;
    };
    expect(res.error).toContain("Avatar generation failed");
  });
});

describe("admin tools — self_write set_display_name", () => {
  it("records the per-workspace admin display name", async () => {
    const wsId = await freshWsId("tools-ws-selfname");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    const res = (await selfWrite(d, {
      operation: "set_display_name",
      displayName: "  Ops Bot  "
    })) as { ok?: boolean; displayName?: string };
    expect(res.ok).toBe(true);
    expect(res.displayName).toBe("Ops Bot");
    expect(await getAdminDisplayName(wsId)).toBe("Ops Bot");
  });

  it("rejects an empty display name", async () => {
    const wsId = await freshWsId("tools-ws-selfname-empty");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(
      await selfWrite(d, { operation: "set_display_name", displayName: "   " })
    ).toHaveProperty("error");
  });

  it("denies a non-admin caller", async () => {
    const wsId = await freshWsId("tools-ws-selfname-deny");
    const d = deps(wsId, ctx({ adminWorkspaces: [999] }));
    expect(
      await selfWrite(d, { operation: "set_display_name", displayName: "X" })
    ).toHaveProperty("error");
  });
});

describe("admin tools — self_write is always registered", () => {
  it("registers self_write with and without the image seams", () => {
    const wsId = 3;
    const base = ctx({ adminWorkspaces: [wsId] });
    const without = buildAdminTools(deps(wsId, base));
    expect(Object.keys(without)).toContain("self_write");
    expect(Object.keys(without)).not.toContain("avatar_regenerate");

    const withSeams = buildAdminTools(avatarDeps(wsId, base));
    expect(Object.keys(withSeams)).toContain("self_write");
  });
});

describe("admin tools — agents_write regenerate_avatar", () => {
  async function registerAgentFor(
    wsId: number,
    name: string,
    d: AdminToolDeps
  ): Promise<void> {
    await agentsWrite(d, {
      operation: "register",
      name,
      a2aEndpoint: `https://${name}.example.com/a2a`,
      notifyOn: "mention"
    });
  }

  it("generates an avatar and sets the custom agent's iconUrl", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar");
    await setPublicUrl("https://gw.example.com");
    const prompts: string[] = [];
    const names: string[] = [];
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }), {
      generateImage: async (p) => {
        prompts.push(p);
        return okImage;
      },
      storeIcon: async (_img, name) => {
        names.push(name);
        return { key: "abc123def4567890", contentType: "image/jpeg" };
      }
    });
    await registerAgentFor(wsId, "paint-agent", d);

    const res = (await agentsWrite(d, {
      operation: "regenerate_avatar",
      name: "paint-agent",
      instructions: "teal owl"
    })) as { ok?: boolean; agent?: { iconUrl?: string } };
    expect(res.ok).toBe(true);
    const expected = `https://gw.example.com/icons/${wsId}/paint-agent/abc123def4567890.jpg`;
    expect(res.agent?.iconUrl).toBe(expected);
    expect((await getAgent("paint-agent"))?.iconUrl).toBe(expected);
    // Prompt anchors on the agent's display name, not the "admin assistant";
    // stored under the per-agent name.
    expect(prompts[0]).toContain("Stubbed Agent"); // the registered displayName
    expect(prompts[0]).not.toContain("admin assistant");
    expect(prompts[0]).toContain("teal owl");
    expect(names).toEqual(["paint-agent"]);
  });

  it("rejects a built-in / reserved agent", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-builtin");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(
      await agentsWrite(d, { operation: "regenerate_avatar", name: "admin" })
    ).toHaveProperty("error");
  });

  it("rejects an agent that doesn't belong to this workspace", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-scope");
    await setPublicUrl("https://gw.example.com");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    expect(
      await agentsWrite(d, {
        operation: "regenerate_avatar",
        name: "nonexistent-agent"
      })
    ).toHaveProperty("error");
  });

  it("errors when the image seams are absent", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-noseam");
    await setPublicUrl("https://gw.example.com");
    const d = deps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerAgentFor(wsId, "noseam-agent", d);
    const res = (await agentsWrite(d, {
      operation: "regenerate_avatar",
      name: "noseam-agent"
    })) as { error?: string };
    expect(res.error).toContain("not available");
  });

  it("errors when the gateway public URL isn't known yet", async () => {
    const wsId = await freshWsId("tools-ws-agent-avatar-nourl");
    const d = avatarDeps(wsId, ctx({ adminWorkspaces: [wsId] }));
    await registerAgentFor(wsId, "nourl-agent", d);
    expect(
      await agentsWrite(d, {
        operation: "regenerate_avatar",
        name: "nourl-agent"
      })
    ).toHaveProperty("error");
  });
});
