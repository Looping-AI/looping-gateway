import { describe, it, expect } from "vitest";
import { parseAgentRef, cleanText } from "@/router/parse";

describe("parseAgentRef", () => {
  it("extracts the first ::name, lowercased", () => {
    expect(parseAgentRef("hey ::Admin do thing")).toBe("admin");
    expect(parseAgentRef("::onboarding-bot hi")).toBe("onboarding-bot");
  });

  it("returns the first ref when several are present", () => {
    expect(parseAgentRef("::admin then ::onboarding")).toBe("admin");
  });

  it("returns null when there is no ref", () => {
    expect(parseAgentRef("<@UBOT> hello")).toBeNull();
    expect(parseAgentRef("just text")).toBeNull();
  });
});

describe("cleanText", () => {
  it("strips bot mentions and ::refs and collapses whitespace", () => {
    expect(cleanText("<@UBOT> ::admin   reset   the registry")).toBe(
      "reset the registry"
    );
  });

  it("strips labeled mentions (<@U123|name>)", () => {
    expect(cleanText("<@U123|bot> hi there")).toBe("hi there");
  });

  it("strips every ref and mention", () => {
    expect(cleanText("::admin <@UBOT> do ::onboarding stuff")).toBe("do stuff");
  });

  it("leaves plain text intact", () => {
    expect(cleanText("just a message")).toBe("just a message");
  });
});
