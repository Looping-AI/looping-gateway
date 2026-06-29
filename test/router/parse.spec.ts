import { describe, it, expect } from "vitest";
import { findAgentNameMention, findAllAgentNameMentions } from "@/router/parse";

describe("findAgentNameMention", () => {
  it("finds the first case-insensitive whole-token agent name", () => {
    expect(
      findAgentNameMention("hey Admin do thing", ["admin", "onboarding-bot"])
    ).toEqual({ name: "admin", index: 4 });
    expect(
      findAgentNameMention("ONBOARDING-BOT hi", ["admin", "onboarding-bot"])
    ).toEqual({ name: "onboarding-bot", index: 0 });
  });

  it("supports punctuation and at-prefixed mentions", () => {
    expect(findAgentNameMention("please ask @ana, thanks", ["ana"])).toEqual({
      name: "ana",
      index: 12
    });
  });

  it("does not match inside another agent-name token", () => {
    expect(findAgentNameMention("banana", ["ana"])).toBeNull();
    expect(findAgentNameMention("ana-bot", ["ana"])).toBeNull();
  });

  it("prefers the first mention, using the longest name for same-index ties", () => {
    expect(
      findAgentNameMention("ana-bot then admin", ["admin", "ana", "ana-bot"])
    ).toEqual({ name: "ana-bot", index: 0 });
    expect(
      findAgentNameMention("admin then ana-bot", ["ana-bot", "admin"])
    ).toEqual({ name: "admin", index: 0 });
  });

  it("returns null when there is no agent name", () => {
    expect(findAgentNameMention("<@UBOT> hello", ["admin"])).toBeNull();
    expect(findAgentNameMention("just text", ["admin"])).toBeNull();
  });
});

describe("findAllAgentNameMentions", () => {
  it("returns every whole-token name, deduped, canonical casing", () => {
    expect(
      findAllAgentNameMentions("Admin and ana-bot, hi admin", [
        "admin",
        "ana-bot",
        "onboarding"
      ])
    ).toEqual(["admin", "ana-bot"]);
  });

  it("ignores partial-token matches", () => {
    expect(findAllAgentNameMentions("banana ana-bot", ["ana"])).toEqual([]);
  });

  it("returns empty when nobody is named", () => {
    expect(findAllAgentNameMentions("just text", ["admin", "ana"])).toEqual([]);
  });
});
