import { describe, it, expect, afterEach, vi } from "vitest";
import { stubSlack } from "./slack-stub";
import {
  iterateSlackUsers,
  iterateSlackChannels,
  fetchChannelMemberIds,
  getBotUserId,
  postReply
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
      displayName: "Owner"
    });
    expect(users[1]).toMatchObject({
      id: "U2",
      isPrimaryOwner: false,
      displayName: "adminuser"
    });
    expect(users[2]).toMatchObject({
      id: "U3",
      deleted: true
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

describe("iterateSlackChannels", () => {
  it("follows the cursor and yields named channels across pages", async () => {
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
    const channels: { id: string; name: string }[] = [];
    for await (const c of iterateSlackChannels(slackEnv)) channels.push(c);
    expect(channels).toEqual([
      { id: "C_OTHER", name: "general" },
      { id: "C_TARGET", name: "looping-org-admin" }
    ]);
  });

  it("skips channels without a name", async () => {
    stubSlack((method) =>
      method === "conversations.list"
        ? { ok: true, channels: [{ id: "C1", name: "ok" }, { id: "C2" }] }
        : { ok: true }
    );
    const ids: string[] = [];
    for await (const c of iterateSlackChannels(slackEnv)) ids.push(c.id);
    expect(ids).toEqual(["C1"]);
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
    // Use a distinct token so the module-level cache from the success test above
    // doesn't short-circuit this call before auth.test can return the error.
    await expect(
      getBotUserId({ SLACK_BOT_TOKEN: "xoxb-error-token" })
    ).rejects.toThrow(/missing_scope/);
  });
});

describe("postReply", () => {
  it("posts a threaded reply with channel + thread_ts + text", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true, ts: "1.2" };
    });
    await postReply(slackEnv, "C1", "1700.1", "hello world");
    expect(captured?.get("channel")).toBe("C1");
    expect(captured?.get("thread_ts")).toBe("1700.1");
    expect(captured?.get("text")).toBe("hello world");
  });

  it("omits thread_ts when null (top-level post)", async () => {
    let captured: URLSearchParams | undefined;
    stubSlack((method, body) => {
      if (method === "chat.postMessage") captured = body;
      return { ok: true };
    });
    await postReply(slackEnv, "D1", null, "hi");
    expect(captured?.has("thread_ts")).toBe(false);
  });

  it("throws on a non-ok response", async () => {
    stubSlack(() => ({ ok: false, error: "channel_not_found" }));
    await expect(postReply(slackEnv, "C1", null, "x")).rejects.toThrow(
      /channel_not_found/
    );
  });
});
