import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  handleTeamJoin,
  handleMemberJoined,
  handleMemberLeft
} from "@/workflows/lifecycle";
import { getDb } from "@/db/client";
import { getSlackUser } from "@/db/models/users";
import { upsertWorkspace } from "@/db/models/workspaces";
import { listWorkspaceAdminIds } from "@/db/models/workspace-admins";
import type { LifecycleWorkflowParams } from "@/slack/types";

const db = getDb(env);
const BOT = "UBOT";

function params(
  overrides: Partial<LifecycleWorkflowParams> & { type: string }
): LifecycleWorkflowParams {
  return { eventId: "ev", raw: {}, ...overrides };
}

describe("handleTeamJoin", () => {
  it("registers the new user with a display name from the envelope", async () => {
    await handleTeamJoin(
      db,
      params({
        type: "team_join",
        userId: "U_new",
        displayName: "New Bie"
      })
    );
    const u = await getSlackUser(db, "U_new");
    expect(u?.displayName).toBe("New Bie");
    expect(u?.isPrimaryOwner).toBe(false);
    expect(u?.isOrgAdmin).toBe(false);
  });

  it("ignores a team_join with no user id", async () => {
    await expect(
      handleTeamJoin(db, params({ type: "team_join" }))
    ).resolves.toBeUndefined();
  });
});

describe("handleMemberJoined", () => {
  it("makes a member of an admin channel a workspace admin", async () => {
    await upsertWorkspace(db, {
      id: 50,
      name: "w50",
      adminChannelId: "C_ADM50"
    });
    await handleMemberJoined(
      db,
      params({
        type: "member_joined_channel",
        userId: "U_join",
        channelId: "C_ADM50"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(db, 50)).has("U_join")).toBe(true);
  });

  it("ignores joins to a non-admin channel", async () => {
    await handleMemberJoined(
      db,
      params({
        type: "member_joined_channel",
        userId: "U_reg",
        channelId: "C_REGULAR"
      }),
      BOT
    );
    expect(await getSlackUser(db, "U_reg")).toBeNull();
  });

  it("ignores the bot's own join to an admin channel", async () => {
    await upsertWorkspace(db, {
      id: 51,
      name: "w51",
      adminChannelId: "C_ADM51"
    });
    await handleMemberJoined(
      db,
      params({
        type: "member_joined_channel",
        userId: BOT,
        channelId: "C_ADM51"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(db, 51)).size).toBe(0);
  });

  it("is idempotent on replay", async () => {
    await upsertWorkspace(db, {
      id: 52,
      name: "w52",
      adminChannelId: "C_ADM52"
    });
    const p = params({
      type: "member_joined_channel",
      userId: "U_rep",
      channelId: "C_ADM52"
    });
    await handleMemberJoined(db, p, BOT);
    await handleMemberJoined(db, p, BOT);
    expect([...(await listWorkspaceAdminIds(db, 52))]).toEqual(["U_rep"]);
  });
});

describe("handleMemberLeft", () => {
  it("removes the workspace admin when they leave the admin channel", async () => {
    await upsertWorkspace(db, {
      id: 53,
      name: "w53",
      adminChannelId: "C_ADM53"
    });
    const join = params({
      type: "member_joined_channel",
      userId: "U_gone",
      channelId: "C_ADM53"
    });
    await handleMemberJoined(db, join, BOT);
    await handleMemberLeft(
      db,
      params({
        type: "member_left_channel",
        userId: "U_gone",
        channelId: "C_ADM53"
      }),
      BOT
    );
    expect((await listWorkspaceAdminIds(db, 53)).size).toBe(0);
  });

  it("leaving a non-admin channel is a no-op", async () => {
    await expect(
      handleMemberLeft(
        db,
        params({
          type: "member_left_channel",
          userId: "U_any",
          channelId: "C_REG2"
        }),
        BOT
      )
    ).resolves.toBeUndefined();
  });
});
