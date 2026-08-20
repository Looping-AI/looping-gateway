import { describe, it, expect } from "vitest";
import {
  describeGatedAction,
  runGatedAction,
  type GatedAction,
  type GatedActionDeps
} from "@/agents/admin/approvals";
import { getAgent, registerAgent, updateAgent } from "@/db/models/agents";
import { makeAuthCtx, freshWsId } from "../../helpers/workspace";

const admin = (wsId: number) => makeAuthCtx({ adminWorkspaces: [wsId] });

/** Offline verifier: every card names `kid`, at the endpoint it was asked about. */
function verifier(kid: string): GatedActionDeps {
  return {
    verifyEndpoint: async (url) => ({
      pin: {
        cardSigningJku: `${new URL(url).origin}/.well-known/jwks.json`,
        cardSigningKid: kid
      },
      displayName: "Stubbed Agent",
      endpoint: url
    })
  };
}

/** The deps for actions that never verify a card. */
const noVerify: GatedActionDeps = {
  verifyEndpoint: async () => {
    throw new Error("verifyEndpoint should not have been called");
  }
};

async function registerCustom(name: string, wsId: number): Promise<void> {
  await registerAgent({
    name,
    kind: "remote",
    displayName: name,
    a2aEndpoint: `https://example.com/${name}`,
    tenantId: "main",
    notifyOn: "mention",
    workspaceId: wsId
  });
}

describe("describeGatedAction", () => {
  it("describes an unregister_agent action", () => {
    expect(
      describeGatedAction({ kind: "unregister_agent", name: "foo", wsId: 1 })
    ).toBe('delete agent "foo"');
  });

  it("describes a repin_agent action", () => {
    expect(
      describeGatedAction({
        kind: "repin_agent",
        name: "foo",
        wsId: 1,
        jku: "https://foo.example.com/.well-known/jwks.json",
        kid: "new-kid"
      })
    ).toBe('re-pin agent "foo" to a new signing key');
  });
});

describe("runGatedAction — unregister_agent", () => {
  it("deletes the agent when the approver administers the workspace", async () => {
    const wsId = await freshWsId("approvals-ok");
    await registerCustom("gated-del", wsId);
    const action: GatedAction = {
      kind: "unregister_agent",
      name: "gated-del",
      wsId
    };

    const result = await runGatedAction(action, admin(wsId), noVerify);

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("gated-del");
    expect(await getAgent("gated-del")).toBeNull();
  });

  it("refuses when the approver is not an admin of the workspace", async () => {
    const wsId = await freshWsId("approvals-unauth");
    await registerCustom("keep-me", wsId);

    const result = await runGatedAction(
      { kind: "unregister_agent", name: "keep-me", wsId },
      makeAuthCtx({ adminWorkspaces: [wsId + 999] }),
      noVerify
    );

    expect(result.ok).toBe(false);
    // The agent must survive an unauthorized approval.
    expect(await getAgent("keep-me")).not.toBeNull();
  });

  it("reports gracefully when the agent is already gone", async () => {
    const wsId = await freshWsId("approvals-missing");
    const result = await runGatedAction(
      { kind: "unregister_agent", name: "never-existed", wsId },
      admin(wsId),
      noVerify
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("never-existed");
  });
});

describe("runGatedAction — repin_agent", () => {
  /** A registered agent carrying an out-of-date pin, plus the action to fix it. */
  async function pinned(
    name: string,
    wsId: number,
    newKid: string
  ): Promise<GatedAction> {
    await registerCustom(name, wsId);
    await updateAgent(name, {
      cardSigningJku: "https://example.com/.well-known/jwks.json",
      cardSigningKid: "old-kid"
    });
    return {
      kind: "repin_agent",
      name,
      wsId,
      jku: "https://example.com/.well-known/jwks.json",
      kid: newKid
    };
  }

  it("writes the approved key when the live card still names it", async () => {
    const wsId = await freshWsId("repin-ok");
    const action = await pinned("repin-ok", wsId, "new-kid");

    const result = await runGatedAction(
      action,
      admin(wsId),
      verifier("new-kid")
    );

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("new-kid");
    const row = await getAgent("repin-ok");
    expect(row?.cardSigningKid).toBe("new-kid");
  });

  it("refuses when the key moved again between the prompt and the approval", async () => {
    const wsId = await freshWsId("repin-moved");
    const action = await pinned("repin-moved", wsId, "new-kid");

    // The human approved `new-kid`; the card now names something else entirely.
    const result = await runGatedAction(
      action,
      admin(wsId),
      verifier("newer-kid")
    );

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("changed again");
    // Neither the approved key nor the surprise one is written.
    expect((await getAgent("repin-moved"))?.cardSigningKid).toBe("old-kid");
  });

  it("refuses when the approver is not an admin of the workspace", async () => {
    const wsId = await freshWsId("repin-unauth");
    const action = await pinned("repin-unauth", wsId, "new-kid");

    const result = await runGatedAction(
      action,
      makeAuthCtx({ adminWorkspaces: [wsId + 999] }),
      verifier("new-kid")
    );

    expect(result.ok).toBe(false);
    expect((await getAgent("repin-unauth"))?.cardSigningKid).toBe("old-kid");
  });

  it("reports gracefully when the card can no longer be read", async () => {
    const wsId = await freshWsId("repin-unreachable");
    const action = await pinned("repin-unreachable", wsId, "new-kid");

    const result = await runGatedAction(action, admin(wsId), {
      verifyEndpoint: async () => {
        throw new Error("card fetch failed");
      }
    });

    expect(result.ok).toBe(false);
    expect(result.summary).toContain("card fetch failed");
    expect((await getAgent("repin-unreachable"))?.cardSigningKid).toBe(
      "old-kid"
    );
  });
});
