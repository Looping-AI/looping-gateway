import { describe, it, expect } from "vitest";
import {
  describeGatedAction,
  runGatedAction,
  type GatedAction
} from "@/agents/admin/approvals";
import { getAgent, registerAgent } from "@/db/models/agents";
import { makeAuthCtx, freshWsId } from "../../helpers/workspace";

const admin = (wsId: number) => makeAuthCtx({ adminWorkspaces: [wsId] });

async function registerCustom(name: string, wsId: number): Promise<void> {
  await registerAgent({
    name,
    kind: "custom",
    displayName: name,
    a2aEndpoint: `https://example.com/${name}`,
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

    const result = await runGatedAction(action, admin(wsId));

    expect(result.ok).toBe(true);
    expect(result.summary).toContain("gated-del");
    expect(await getAgent("gated-del")).toBeNull();
  });

  it("refuses when the approver is not an admin of the workspace", async () => {
    const wsId = await freshWsId("approvals-unauth");
    await registerCustom("keep-me", wsId);

    const result = await runGatedAction(
      { kind: "unregister_agent", name: "keep-me", wsId },
      makeAuthCtx({ adminWorkspaces: [wsId + 999] })
    );

    expect(result.ok).toBe(false);
    // The agent must survive an unauthorized approval.
    expect(await getAgent("keep-me")).not.toBeNull();
  });

  it("reports gracefully when the agent is already gone", async () => {
    const wsId = await freshWsId("approvals-missing");
    const result = await runGatedAction(
      { kind: "unregister_agent", name: "never-existed", wsId },
      admin(wsId)
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("never-existed");
  });
});
