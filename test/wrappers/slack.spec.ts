import { describe, it, expect, afterEach, vi } from "vitest";
import { stubSlack } from "./slack-stub";
import {
  iterateSlackUsers,
  fetchChannelMemberIds,
  findChannelIdByName,
  getBotUserId
} from "@/wrappers/slack";
import type { SlackUserInfo } from "@/wrappers/slack";

const slackEnv = { SLACK_BOT_TOKEN: "xoxb-test" };

afterEach(() => vi.unstubAllGlobals());

describe("iterateSlackUsers", () => {
  it("follows the cursor across pages", async () => {
    stubSlack((method, body) => {
      if (method !== "users.list") return { ok: true };
      return body.get("cursor")
        ? { ok: true, members: [{ id: "U2" }] }
        : {
            ok: true,
            members: [{ id: "U1" }],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const ids: string[] = [];
    for await (const u of iterateSlackUsers(slackEnv)) ids.push(u.id);
    expect(ids).toEqual(["U1", "U2"]);
  });

  it("normalizes flags and prefers display name", async () => {
    stubSlack((method) =>
      method === "users.list"
        ? {
            ok: true,
            members: [
              {
                id: "U1",
                is_primary_owner: true,
                profile: { display_name: "Owner", real_name: "Owner Real" }
              },
              { id: "U2", is_admin: true, name: "adminuser" },
              { id: "U3", deleted: true }
            ]
          }
        : { ok: true }
    );
    const users: SlackUserInfo[] = [];
    for await (const u of iterateSlackUsers(slackEnv)) users.push(u);
    expect(users[0]).toMatchObject({
      id: "U1",
      isPrimaryOwner: true,
      isOrgAdmin: true,
      displayName: "Owner"
    });
    expect(users[1]).toMatchObject({
      id: "U2",
      isPrimaryOwner: false,
      isOrgAdmin: true,
      displayName: "adminuser"
    });
    expect(users[2]).toMatchObject({
      id: "U3",
      deleted: true,
      isOrgAdmin: false
    });
  });
});

describe("fetchChannelMemberIds", () => {
  it("follows the cursor and unions members", async () => {
    stubSlack((method, body) => {
      if (method !== "conversations.members") return { ok: true };
      return body.get("cursor")
        ? { ok: true, members: ["U3"] }
        : {
            ok: true,
            members: ["U1", "U2"],
            response_metadata: { next_cursor: "c2" }
          };
    });
    const ids = await fetchChannelMemberIds(slackEnv, "C1");
    expect([...ids].sort()).toEqual(["U1", "U2", "U3"]);
  });
});

describe("findChannelIdByName", () => {
  it("resolves a channel id by name across pages", async () => {
    stubSlack((method, body) => {
      if (method !== "conversations.list") return { ok: true };
      return body.get("cursor")
        ? {
            ok: true,
            channels: [{ id: "C_TARGET", name: "looping-org-admin" }]
          }
        : {
            ok: true,
            channels: [{ id: "C_OTHER", name: "general" }],
            response_metadata: { next_cursor: "c2" }
          };
    });
    expect(await findChannelIdByName(slackEnv, "looping-org-admin")).toBe(
      "C_TARGET"
    );
  });

  it("returns null when nothing matches", async () => {
    stubSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [] }
        : { ok: true }
    );
    expect(await findChannelIdByName(slackEnv, "nope")).toBeNull();
  });
});

describe("getBotUserId", () => {
  it("resolves the bot user id", async () => {
    stubSlack((method) =>
      method === "auth.test" ? { ok: true, user_id: "UBOT" } : { ok: true }
    );
    expect(await getBotUserId(slackEnv)).toBe("UBOT");
  });

  it("throws on a non-ok response (e.g. missing scope)", async () => {
    stubSlack(() => ({ ok: false, error: "missing_scope" }));
    await expect(getBotUserId(slackEnv)).rejects.toThrow(/missing_scope/);
  });
});
