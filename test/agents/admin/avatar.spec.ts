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
  it("sends a multipart form body and decodes the base64 image into bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 250, 255]);
    const b64 = btoa(String.fromCharCode(...bytes));
    let model: string | undefined;
    let input:
      { multipart?: { body?: unknown; contentType?: string } } | undefined;
    const fakeEnv = {
      AI: {
        run: async (m: string, i: typeof input) => {
          model = m;
          input = i;
          return { image: b64 };
        }
      }
    } as unknown as Env;

    const img = await generateAvatar(fakeEnv, "a prompt");
    expect(img.contentType).toBe("image/jpeg");
    expect([...img.data]).toEqual([...bytes]);

    // The model is called with the multipart envelope FLUX.2 requires.
    expect(model).toBe("@cf/black-forest-labs/flux-2-klein-9b");
    expect(input?.multipart?.body).toBeInstanceOf(ReadableStream);
    expect(input?.multipart?.contentType).toContain("multipart/form-data");
    expect(input?.multipart?.contentType).toContain("boundary=");
  });

  it("throws when the model returns no image data", async () => {
    const fakeEnv = { AI: { run: async () => ({}) } } as unknown as Env;
    await expect(generateAvatar(fakeEnv, "a prompt")).rejects.toThrow();
  });
});
