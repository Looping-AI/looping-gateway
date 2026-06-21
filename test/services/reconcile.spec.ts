import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { env } from "cloudflare:workers";
import { stubSlack } from "../wrappers/slack-stub";
import { reconcile } from "@/services/reconcile";
import { getDb } from "@/db/client";
import { getSlackUser, upsertSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import {
  addWorkspaceAdmin,
  listWorkspaceAdminIds
} from "@/db/models/workspace-admins";
import {
  getConfig,
  setConfig,
  unsetConfig,
  SystemConfigKeys
} from "@/db/models/workspace-configs";
import { ORG_WORKSPACE_ID } from "@/db/models/workspaces";
import { _resetBotInfoCacheForTest } from "@/wrappers/slack";

const db = getDb(env);

afterEach(() => vi.unstubAllGlobals());

describe("reconcile — users", () => {
  it("syncs display names and isPrimaryOwner from users.list", async () => {
    stubSlack((method) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.list") return { ok: true, channels: [] };
      if (method === "users.list")
        return {
          ok: true,
          members: [
            {
              id: "U1",
              profile: { real_name: "One" },
              is_primary_owner: true
            },
            { id: "U2", name: "two" }
          ]
        };
      return { ok: true };
    });
    const r = await reconcile(env);
    expect((await getSlackUser(db, "U1"))?.isPrimaryOwner).toBe(true);
    expect((await getSlackUser(db, "U1"))?.displayName).toBe("One");
    expect((await getSlackUser(db, "U2"))?.isPrimaryOwner).toBe(false);
    expect(r.usersUpserted).toBe(2);
  });

  it("sets isOrgAdmin from looping_org_admin channel membership, not workspace flags", async () => {
    stubSlack((method, body) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.list")
        return {
          ok: true,
          channels: [{ id: "CORG", name: "looping-org-admin" }]
        };
      if (method === "users.list")
        return {
          ok: true,
          members: [
            // U1: Slack workspace admin but NOT in org-admin channel
            { id: "U1", is_admin: true },
            // U2: no Slack admin flags but IS in org-admin channel
            { id: "U2" }
          ]
        };
      if (method === "conversations.members")
        return body.get("channel") === "CORG"
          ? { ok: true, members: ["U2"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    await reconcile(env);
    expect((await getSlackUser(db, "U1"))?.isOrgAdmin).toBe(false);
    expect((await getSlackUser(db, "U2"))?.isOrgAdmin).toBe(true);
  });

  it("marks a registry user absent from users.list as deleted", async () => {
    await upsertSlackUser(db, { slackUserId: "U_gone_recon" });
    stubSlack((method) => {
      if (method === "conversations.list") return { ok: true, channels: [] };
      if (method === "users.list")
        return { ok: true, members: [{ id: "U_present" }] };
      return { ok: true };
    });
    const r = await reconcile(env);
    expect((await getSlackUser(db, "U_gone_recon"))?.deleted).toBe(true);
    expect(r.usersDeactivated).toBeGreaterThanOrEqual(1);
  });
});

describe("reconcile — admin-channel membership", () => {
  it("adds desired members and removes stale ones (bot excluded)", async () => {
    await upsertWorkspace(db, { id: 60, name: "w60", adminChannelId: "C60" });
    await addWorkspaceAdmin(db, 60, "U_stale");
    stubSlack((method, body) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.list") return { ok: true, channels: [] };
      if (method === "users.list") return { ok: true, members: [] };
      if (method === "conversations.members")
        return body.get("channel") === "C60"
          ? { ok: true, members: ["U_keep", "U_new", "UBOT"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    const r = await reconcile(env);
    expect([...(await listWorkspaceAdminIds(db, 60))].sort()).toEqual([
      "U_keep",
      "U_new"
    ]);
    expect(r.adminsAdded).toBe(2);
    expect(r.adminsRemoved).toBe(1);
  });

  it("is a no-op on a second run (no spurious add/remove)", async () => {
    stubSlack((method, body) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "users.list") return { ok: true, members: [{ id: "U1" }] };
      if (method === "conversations.list")
        return {
          ok: true,
          channels: [{ id: "CORG", name: "looping-org-admin" }]
        };
      if (method === "conversations.members")
        return body.get("channel") === "CORG"
          ? { ok: true, members: ["U1"] }
          : { ok: true, members: [] };
      return { ok: true };
    });
    await reconcile(env);
    const r2 = await reconcile(env);
    expect(r2.adminsAdded).toBe(0);
    expect(r2.adminsRemoved).toBe(0);
    expect(r2.usersDeactivated).toBe(0);
  });
});

describe("reconcile — team-id anchor (TOFU)", () => {
  const db = getDb(env);

  beforeEach(async () => {
    // Start each test with a clean anchor and a fresh auth.test cache so the
    // stub response is always used (the cache is per-token and shared within
    // the same test file's isolate).
    await unsetConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID);
    _resetBotInfoCacheForTest();
  });

  afterEach(() => vi.unstubAllGlobals());

  const baseStub = (method: string) => {
    if (method === "users.list") return { ok: true, members: [] };
    if (method === "conversations.list") return { ok: true, channels: [] };
    return { ok: true };
  };

  it("pins the team_id on the first run and sets teamIdBootstrapped", async () => {
    stubSlack((method) => {
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_FIRST" };
      return baseStub(method);
    });
    const r = await reconcile(env);
    expect(r.teamIdBootstrapped).toBe(true);
    const db = getDb(env);
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_FIRST");
  });

  it("is a no-op on a subsequent run with the same team_id", async () => {
    const db = getDb(env);
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_STABLE"
    );
    stubSlack((method) => {
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_STABLE" };
      return baseStub(method);
    });
    const r = await reconcile(env);
    expect(r.teamIdBootstrapped).toBe(false);
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_STABLE");
  });

  it("aborts reconcile and does NOT overwrite the anchor on team_id mismatch", async () => {
    const db = getDb(env);
    await setConfig(
      db,
      ORG_WORKSPACE_ID,
      SystemConfigKeys.SLACK_TEAM_ID,
      "T_ORIGINAL"
    );
    const calledMethods: string[] = [];
    stubSlack((method) => {
      calledMethods.push(method);
      if (method === "auth.test")
        return { ok: true, user_id: "UBOT", team_id: "T_DRIFTED" };
      return { ok: true, members: [], channels: [] };
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await reconcile(env);
    expect(r.teamIdBootstrapped).toBe(false);
    expect(r.usersUpserted).toBe(0);
    expect(r.usersDeactivated).toBe(0);
    expect(r.adminsAdded).toBe(0);
    expect(r.adminsRemoved).toBe(0);
    // Anchor is preserved — never overwritten
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBe("T_ORIGINAL");
    // No further Slack API calls after auth.test
    expect(calledMethods.filter((m) => m !== "auth.test")).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("drifted to a different Slack workspace"),
      expect.objectContaining({ pinned: "T_ORIGINAL", liveTeamId: "T_DRIFTED" })
    );
    errorSpy.mockRestore();
  });

  it("skips pinning when auth.test returns no team_id", async () => {
    stubSlack((method) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      return baseStub(method);
    });
    const db = getDb(env);
    const r = await reconcile(env);
    expect(r.teamIdBootstrapped).toBe(false);
    expect(
      await getConfig(db, ORG_WORKSPACE_ID, SystemConfigKeys.SLACK_TEAM_ID)
    ).toBeNull();
  });
});
