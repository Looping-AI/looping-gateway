import { describe, it, expect } from "vitest";
import {
  upsertSlackChannel,
  getSlackChannelName,
  getSlackChannelIdByName
} from "@/db/models/channels";

describe("slack_channels", () => {
  it("inserts then updates the name by id (rename)", async () => {
    await upsertSlackChannel({ channelId: "C_up", name: "old-name" });
    await upsertSlackChannel({ channelId: "C_up", name: "new-name" });
    expect(await getSlackChannelName("C_up")).toBe("new-name");
  });

  it("resolves a channel id by name", async () => {
    await upsertSlackChannel({ channelId: "C_byname", name: "general" });
    expect(await getSlackChannelIdByName("general")).toBe("C_byname");
  });

  it("returns null for an unknown channel id", async () => {
    expect(await getSlackChannelName("C_nope")).toBeNull();
  });

  it("returns null for an unknown name", async () => {
    expect(await getSlackChannelIdByName("no-such-channel")).toBeNull();
  });
});
