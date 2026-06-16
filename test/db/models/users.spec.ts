import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  upsertSlackUser,
  getSlackUser,
  markUserDeleted
} from "@/db/models/users";

const db = getDb(env);

describe("slack_users", () => {
  it("inserts then updates by id (upsert)", async () => {
    await upsertSlackUser(db, { slackUserId: "U_up", displayName: "First" });
    await upsertSlackUser(db, { slackUserId: "U_up", displayName: "Second" });
    const u = await getSlackUser(db, "U_up");
    expect(u?.displayName).toBe("Second");
  });

  it("does NOT clobber owner/admin flags on a membership-only upsert", async () => {
    await upsertSlackUser(db, {
      slackUserId: "U_flags",
      isPrimaryOwner: true,
      isOrgAdmin: true
    });
    await upsertSlackUser(db, { slackUserId: "U_flags" });
    const u = await getSlackUser(db, "U_flags");
    expect(u?.isPrimaryOwner).toBe(true);
    expect(u?.isOrgAdmin).toBe(true);
  });

  it("does NOT clobber a known display name with a null", async () => {
    await upsertSlackUser(db, { slackUserId: "U_name", displayName: "Known" });
    await upsertSlackUser(db, { slackUserId: "U_name", displayName: null });
    const u = await getSlackUser(db, "U_name");
    expect(u?.displayName).toBe("Known");
  });

  it("marks a user deleted", async () => {
    await upsertSlackUser(db, { slackUserId: "U_del" });
    await markUserDeleted(db, "U_del", true);
    expect((await getSlackUser(db, "U_del"))?.deleted).toBe(true);
  });

  it("returns null for an unknown user", async () => {
    expect(await getSlackUser(db, "U_nope")).toBeNull();
  });
});
