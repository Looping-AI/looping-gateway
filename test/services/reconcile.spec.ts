import { describe, it, expect, afterEach, vi } from "vitest";
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

const db = getDb(env);

afterEach(() => vi.unstubAllGlobals());

describe("reconcile — users", () => {
  it("syncs owner/admin flags and display names from users.list", async () => {
    stubSlack((method) => {
      if (method === "auth.test") return { ok: true, user_id: "UBOT" };
      if (method === "conversations.list") return { ok: true, channels: [] };
      if (method === "users.list")
        return {
          ok: true,
          members: [
            { id: "U1", profile: { real_name: "One" }, is_admin: true },
            { id: "U2", name: "two" }
          ]
        };
      return { ok: true };
    });
    const r = await reconcile(env);
    expect((await getSlackUser(db, "U1"))?.isOrgAdmin).toBe(true);
    expect((await getSlackUser(db, "U1"))?.displayName).toBe("One");
    expect((await getSlackUser(db, "U2"))?.isOrgAdmin).toBe(false);
    expect(r.usersUpserted).toBe(2);
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
