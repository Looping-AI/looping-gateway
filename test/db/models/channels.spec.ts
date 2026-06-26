import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { getDb } from "@/db/client";
import {
  upsertSlackChannel,
  getSlackChannelName,
  getSlackChannelIdByName
} from "@/db/models/channels";

const db = getDb(env);

describe("slack_channels", () => {
  it("inserts then updates the name by id (rename)", async () => {
    await upsertSlackChannel(db, { channelId: "C_up", name: "old-name" });
    await upsertSlackChannel(db, { channelId: "C_up", name: "new-name" });
    expect(await getSlackChannelName(db, "C_up")).toBe("new-name");
  });

  it("resolves a channel id by name", async () => {
    await upsertSlackChannel(db, { channelId: "C_byname", name: "general" });
    expect(await getSlackChannelIdByName(db, "general")).toBe("C_byname");
  });

  it("returns null for an unknown channel id", async () => {
    expect(await getSlackChannelName(db, "C_nope")).toBeNull();
  });

  it("returns null for an unknown name", async () => {
    expect(await getSlackChannelIdByName(db, "no-such-channel")).toBeNull();
  });
});
