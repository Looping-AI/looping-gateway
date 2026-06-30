import { describe, it, expect } from "vitest";
import { buildAvatarPrompt, generateAvatar } from "@/agents/admin/avatar";

describe("buildAvatarPrompt", () => {
  it("includes the workspace name and the caller's art direction", () => {
    const p = buildAvatarPrompt({
      workspaceName: "Acme Corp",
      instructions: "friendly blue robot"
    });
    expect(p).toContain("Acme Corp");
    expect(p).toContain("friendly blue robot");
  });

  it("omits absent instructions without leaving a gap", () => {
    const p = buildAvatarPrompt({ workspaceName: "Acme Corp" });
    expect(p).toContain("Acme Corp");
    expect(p).not.toContain("undefined");
  });
});

describe("generateAvatar", () => {
  it("decodes the model's base64 image into bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 255]);
    const b64 = btoa(String.fromCharCode(...bytes));
    const fakeEnv = {
      AI: { run: async () => ({ image: b64 }) }
    } as unknown as Env;

    const img = await generateAvatar(fakeEnv, "a prompt");
    expect(img.contentType).toBe("image/jpeg");
    expect([...img.data]).toEqual([...bytes]);
  });

  it("throws when the model returns no image data", async () => {
    const fakeEnv = { AI: { run: async () => ({}) } } as unknown as Env;
    await expect(generateAvatar(fakeEnv, "a prompt")).rejects.toThrow();
  });
});
