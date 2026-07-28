import { describe, it, expect } from "vitest";
import { hasSlackCommandSequence, sanitizeSlackText } from "@/util/slack-text";
import { sanitizeDisplayName } from "@/util/display-name";

describe("sanitizeSlackText", () => {
  it("defangs every broadcast/command sequence", () => {
    const out = sanitizeSlackText(
      "<!channel> <!here> <!everyone> <!subteam^S1|@grp>"
    );
    expect(out).not.toContain("<!");
    expect(out).toBe("@channel @here @everyone @subteam^S1|@grp");
  });

  it("leaves user and channel mentions intact", () => {
    expect(sanitizeSlackText("hi <@U123> in <#C456>")).toBe(
      "hi <@U123> in <#C456>"
    );
  });

  it("strips control characters but keeps tabs and newlines", () => {
    expect(sanitizeSlackText("ab\tc\nd")).toBe("ab\tc\nd");
  });
});

describe("hasSlackCommandSequence", () => {
  it("detects a command sequence anywhere in the string", () => {
    expect(hasSlackCommandSequence("Ops <!here> Bot")).toBe(true);
    // Non-global regex reuse must not carry state between calls.
    expect(hasSlackCommandSequence("Ops <!here> Bot")).toBe(true);
  });

  it("does not flag ordinary names or plain mentions", () => {
    expect(hasSlackCommandSequence("Ops Bot")).toBe(false);
    expect(hasSlackCommandSequence("Ops <@U123> Bot")).toBe(false);
  });
});

describe("sanitizeDisplayName", () => {
  it("defangs a broadcast name so it cannot @-notify a channel", () => {
    expect(sanitizeDisplayName("<!channel>")).toBe("@channel");
  });

  it("collapses whitespace and trims so the name stays one line", () => {
    expect(sanitizeDisplayName("  Ops\n  Bot  ")).toBe("Ops Bot");
  });

  it("returns empty when nothing renderable survives", () => {
    expect(sanitizeDisplayName("  ")).toBe("");
  });
});
