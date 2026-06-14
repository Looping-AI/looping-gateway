import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  upsertWorkspace,
  getWorkspace,
  getWorkspaceByAdminChannel,
  setWorkspaceAdminChannel
} from "@/db/models/workspaces";

const db = getDb(env);

describe("workspaces", () => {
  it("upserts and reads back, including by admin channel", async () => {
    await upsertWorkspace(db, {
      id: 10,
      name: "payments",
      adminChannelId: "C_PAY"
    });
    expect((await getWorkspace(db, 10))?.name).toBe("payments");
    expect((await getWorkspaceByAdminChannel(db, "C_PAY"))?.id).toBe(10);
  });

  it("upsert without an admin channel does not clobber an existing one", async () => {
    await upsertWorkspace(db, { id: 11, name: "ws", adminChannelId: "C_KEEP" });
    await upsertWorkspace(db, { id: 11, name: "ws-renamed" });
    const ws = await getWorkspace(db, 11);
    expect(ws?.name).toBe("ws-renamed");
    expect(ws?.adminChannelId).toBe("C_KEEP");
  });

  it("sets the admin channel later", async () => {
    await upsertWorkspace(db, { id: 12, name: "later" });
    await setWorkspaceAdminChannel(db, 12, "C_LATER");
    expect((await getWorkspace(db, 12))?.adminChannelId).toBe("C_LATER");
  });
});
