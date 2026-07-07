import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import { upsertWorkspace } from "@/db/models/workspaces";
import { getSlackUser } from "@/db/models/users";
import {
  addWorkspaceAdmin,
  removeWorkspaceAdmin,
  listWorkspaceAdminIds,
  getAdminWorkspaces
} from "@/db/models/workspace-admins";

const db = getDb();

describe("workspace_admins", () => {
  it("adds an admin idempotently and auto-stubs an unknown user", async () => {
    await upsertWorkspace({ id: 20, name: "w20" });
    await addWorkspaceAdmin(20, "U_admin");
    await addWorkspaceAdmin(20, "U_admin"); // duplicate → no error
    expect([...(await listWorkspaceAdminIds(20))]).toEqual(["U_admin"]);
    expect(await getSlackUser("U_admin")).not.toBeNull();
  });

  it("removing a missing admin row is a no-op", async () => {
    await upsertWorkspace({ id: 21, name: "w21" });
    await expect(removeWorkspaceAdmin(21, "U_ghost")).resolves.toBeUndefined();
  });

  it("add then remove clears the row", async () => {
    await upsertWorkspace({ id: 22, name: "w22" });
    await addWorkspaceAdmin(22, "U_x");
    await removeWorkspaceAdmin(22, "U_x");
    expect((await listWorkspaceAdminIds(22)).size).toBe(0);
  });

  it("does not remove a bootstrap-source admin via removeWorkspaceAdmin", async () => {
    await upsertWorkspace({ id: 23, name: "w23" });
    await addWorkspaceAdmin(23, "U_boot", "bootstrap");
    await removeWorkspaceAdmin(23, "U_boot"); // no-op: only removes membership rows
    expect((await listWorkspaceAdminIds(23)).size).toBe(1);
  });

  it("tracks a user that administers multiple workspaces", async () => {
    await upsertWorkspace({ id: 30, name: "a" });
    await upsertWorkspace({ id: 31, name: "b" });
    await addWorkspaceAdmin(30, "U_multi");
    await addWorkspaceAdmin(31, "U_multi");
    const ws = await getAdminWorkspaces("U_multi");
    expect(ws.sort()).toEqual([30, 31]);
  });
});
