import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  getConfig,
  setConfig,
  unsetConfig,
  getAdminIconUrl,
  setAdminIconUrl,
  SystemConfigKeys
} from "@/db/models/workspace-configs";
import { upsertWorkspace } from "@/db/models/workspaces";

const db = getDb(env);

// Workspace 0 is seeded by migrations; we use a unique workspace for
// isolation between parallel test runs.
const WS_ID = 200;

describe("workspace_configs", () => {
  it("returns null for an absent key", async () => {
    await upsertWorkspace(db, { id: WS_ID, name: "cfgtest" });
    expect(await getConfig(db, WS_ID, "missing_key")).toBeNull();
  });

  it("sets a value and reads it back", async () => {
    await upsertWorkspace(db, { id: WS_ID, name: "cfgtest" });
    await setConfig(db, WS_ID, "my_key", "my_value");
    expect(await getConfig(db, WS_ID, "my_key")).toBe("my_value");
  });

  it("upserts (overwrites) an existing value", async () => {
    await upsertWorkspace(db, { id: WS_ID, name: "cfgtest" });
    await setConfig(db, WS_ID, "over_key", "v1");
    await setConfig(db, WS_ID, "over_key", "v2");
    expect(await getConfig(db, WS_ID, "over_key")).toBe("v2");
  });

  it("unsets a key (row deleted, get returns null)", async () => {
    await upsertWorkspace(db, { id: WS_ID, name: "cfgtest" });
    await setConfig(db, WS_ID, "del_key", "delete_me");
    await unsetConfig(db, WS_ID, "del_key");
    expect(await getConfig(db, WS_ID, "del_key")).toBeNull();
  });

  it("unset is a no-op when the key is absent", async () => {
    await upsertWorkspace(db, { id: WS_ID, name: "cfgtest" });
    await expect(unsetConfig(db, WS_ID, "never_set")).resolves.toBeUndefined();
  });

  it("different workspaces hold independent values for the same key", async () => {
    await upsertWorkspace(db, { id: 201, name: "cfgtest_a" });
    await upsertWorkspace(db, { id: 202, name: "cfgtest_b" });
    await setConfig(db, 201, "shared_key", "ws201_value");
    await setConfig(db, 202, "shared_key", "ws202_value");
    expect(await getConfig(db, 201, "shared_key")).toBe("ws201_value");
    expect(await getConfig(db, 202, "shared_key")).toBe("ws202_value");
  });

  it("SystemConfigKeys.SLACK_TEAM_ID is the reserved system key", () => {
    expect(SystemConfigKeys.SLACK_TEAM_ID).toBe("slack_team_id");
  });

  it("admin icon URL is workspace-scoped (null when unset, round-trips per ws)", async () => {
    await upsertWorkspace(db, { id: 203, name: "iconcfg_a" });
    await upsertWorkspace(db, { id: 204, name: "iconcfg_b" });
    expect(await getAdminIconUrl(db, 203)).toBeNull();

    await setAdminIconUrl(
      db,
      203,
      "https://gw.example.com/icons/admin/203/a.jpg"
    );
    await setAdminIconUrl(
      db,
      204,
      "https://gw.example.com/icons/admin/204/b.jpg"
    );
    expect(await getAdminIconUrl(db, 203)).toBe(
      "https://gw.example.com/icons/admin/203/a.jpg"
    );
    expect(await getAdminIconUrl(db, 204)).toBe(
      "https://gw.example.com/icons/admin/204/b.jpg"
    );
  });
});
