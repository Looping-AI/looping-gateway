import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { buildUserAuthContext } from "@/auth/build";
import { getDb } from "@/db/client";
import { upsertSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import { addWorkspaceAdmin } from "@/db/models/workspace-admins";

const db = getDb(env);

describe("buildUserAuthContext", () => {
  it("returns a zero-permission context for an unknown user", async () => {
    const c = await buildUserAuthContext(db, "U_unknown");
    expect(c).toEqual({
      slackUserId: "U_unknown",
      displayName: null,
      isPrimaryOwner: false,
      isOrgAdmin: false,
      adminWorkspaces: []
    });
  });

  it("assembles flags + derived adminWorkspaces from D1", async () => {
    await upsertWorkspace(db, { id: 40, name: "w40" });
    await upsertWorkspace(db, { id: 41, name: "w41" });
    await upsertSlackUser(db, {
      slackUserId: "U_ctx",
      displayName: "Ctx User",
      isOrgAdmin: true
    });
    await addWorkspaceAdmin(db, 40, "U_ctx");
    await addWorkspaceAdmin(db, 41, "U_ctx");

    const c = await buildUserAuthContext(db, "U_ctx");
    expect(c.displayName).toBe("Ctx User");
    expect(c.isOrgAdmin).toBe(true);
    expect(c.isPrimaryOwner).toBe(false);
    expect(c.adminWorkspaces.sort()).toEqual([40, 41]);
  });
});
