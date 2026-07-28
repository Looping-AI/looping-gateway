import { describe, it, expect } from "vitest";
import { hasSlackBroadcast, sanitizeSlackText } from "@/util/slack-text";
import { sanitizeDisplayName } from "@/util/display-name";

describe("sanitizeSlackText", () => {
  it("neutralizes command-sequence broadcasts", () => {
    const out = sanitizeSlackText(
      "<!channel> <!here> <!everyone> <!subteam^S1|@grp>"
    );
    expect(out).not.toContain("<!");
    expect(out).toBe("channel here everyone subteam^S1|@grp");
  });

  it("neutralizes plain @channel / @here / @everyone", () => {
    expect(sanitizeSlackText("hey @channel and @Here and @everyone")).toBe(
      "hey channel and Here and everyone"
    );
  });

  it("leaves lookalikes and single mentions alone", () => {
    expect(
      sanitizeSlackText("mail ops@here.com about @channels via <@U1> in <#C2>")
    ).toBe("mail ops@here.com about @channels via <@U1> in <#C2>");
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(sanitizeSlackText("ab\tc\nd")).toBe("ab\tc\nd");
  });
});

describe("hasSlackBroadcast", () => {
  it("detects both spellings anywhere in the string", () => {
    expect(hasSlackBroadcast("Ops <!here> Bot")).toBe(true);
    expect(hasSlackBroadcast("Ops @here Bot")).toBe(true);
    // Regex reuse must not carry lastIndex state between calls.
    expect(hasSlackBroadcast("Ops @here Bot")).toBe(true);
  });

  it("does not flag ordinary names, addresses or single mentions", () => {
    expect(hasSlackBroadcast("Ops Bot")).toBe(false);
    expect(hasSlackBroadcast("Ops <@U123> Bot")).toBe(false);
    expect(hasSlackBroadcast("ops@here.com")).toBe(false);
    expect(hasSlackBroadcast("@channels")).toBe(false);
  });
});

describe("sanitizeDisplayName", () => {
  it("neutralizes a broadcast name in either spelling", () => {
    expect(sanitizeDisplayName("<!channel>")).toBe("channel");
    expect(sanitizeDisplayName("@everyone Bot")).toBe("everyone Bot");
  });

  it("collapses whitespace and trims so the name stays one line", () => {
    expect(sanitizeDisplayName("  Ops\n  Bot  ")).toBe("Ops Bot");
  });

  it("returns empty when nothing renderable survives", () => {
    expect(sanitizeDisplayName("  ")).toBe("");
  });
});
