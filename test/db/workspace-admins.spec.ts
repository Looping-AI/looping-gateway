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

const db = getDb(env);

describe("workspace_admins", () => {
  it("adds an admin idempotently and auto-stubs an unknown user", async () => {
    await upsertWorkspace(db, { id: 20, name: "w20" });
    await addWorkspaceAdmin(db, 20, "U_admin");
    await addWorkspaceAdmin(db, 20, "U_admin"); // duplicate → no error
    expect([...(await listWorkspaceAdminIds(db, 20))]).toEqual(["U_admin"]);
    expect(await getSlackUser(db, "U_admin")).not.toBeNull();
  });

  it("removing a missing admin row is a no-op", async () => {
    await upsertWorkspace(db, { id: 21, name: "w21" });
    await expect(
      removeWorkspaceAdmin(db, 21, "U_ghost")
    ).resolves.toBeUndefined();
  });

  it("add then remove clears the row", async () => {
    await upsertWorkspace(db, { id: 22, name: "w22" });
    await addWorkspaceAdmin(db, 22, "U_x");
    await removeWorkspaceAdmin(db, 22, "U_x");
    expect((await listWorkspaceAdminIds(db, 22)).size).toBe(0);
  });

  it("tracks a user that administers multiple workspaces", async () => {
    await upsertWorkspace(db, { id: 30, name: "a" });
    await upsertWorkspace(db, { id: 31, name: "b" });
    await addWorkspaceAdmin(db, 30, "U_multi");
    await addWorkspaceAdmin(db, 31, "U_multi");
    const ws = await getAdminWorkspaces(db, "U_multi");
    expect(ws.sort()).toEqual([30, 31]);
  });
});
