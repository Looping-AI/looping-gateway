import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import {
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";
import worker from "../src/server";

describe("Worker routing", () => {
  it("returns 404 for GET /", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(new Request("http://localhost/"), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown paths", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/some-unknown-path"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  it("routes POST /slack/events to the Slack webhook handler", async () => {
    // A missing-signature request reaching the handler proves routing works;
    // the full ingress pipeline is tested in slack-webhook-handler.spec.ts.
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "url_verification", challenge: "x" })
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    // No signature headers → 401 from the handler (proves routing reached it)
    expect(res.status).toBe(401);
  });

  it("serves a stored admin avatar with a long immutable cache", async () => {
    // Seed an avatar in the admin:0 DO, then fetch it through the public route.
    const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:0"));
    const data = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    const { key } = await stub.putIcon(data, "image/jpeg");

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request(`http://localhost/icons/admin/0/${key}.jpg`),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("cache-control")).toContain("max-age=31536000");
    expect(res.headers.get("cache-control")).toContain("s-maxage=31536000");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([...data]);
  });

  it("returns 404 for an unknown admin avatar key", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/icons/admin/0/deadbeefdeadbeef.jpg"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(404);
  });

  describe("admin avatar icon index (sliding window pruning)", () => {
    it("keeps both icons when exactly ICON_KEEP (2) are stored", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:10"));
      const { key: k1 } = await stub.putIcon(
        new Uint8Array([0x01]),
        "image/jpeg"
      );
      const { key: k2 } = await stub.putIcon(
        new Uint8Array([0x02]),
        "image/jpeg"
      );
      expect(await stub.getIcon(k1)).not.toBeNull();
      expect(await stub.getIcon(k2)).not.toBeNull();
    });

    it("evicts the oldest icon when a 3rd distinct icon is stored", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:11"));
      const { key: k1 } = await stub.putIcon(
        new Uint8Array([0x0a]),
        "image/jpeg"
      );
      const { key: k2 } = await stub.putIcon(
        new Uint8Array([0x0b]),
        "image/jpeg"
      );
      const { key: k3 } = await stub.putIcon(
        new Uint8Array([0x0c]),
        "image/jpeg"
      );
      expect(await stub.getIcon(k1)).toBeNull(); // pruned
      expect(await stub.getIcon(k2)).not.toBeNull();
      expect(await stub.getIcon(k3)).not.toBeNull();
    });

    it("deduplicates: storing the same bytes twice does not grow the index", async () => {
      const stub = env.AdminAgent.get(env.AdminAgent.idFromName("admin:12"));
      const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
      const { key: k1 } = await stub.putIcon(bytes, "image/jpeg");
      const { key: k2 } = await stub.putIcon(bytes, "image/jpeg");
      expect(k1).toBe(k2); // same content → same hash
      // A third distinct icon should only evict nothing (index length is still 1).
      const { key: k3 } = await stub.putIcon(
        new Uint8Array([0x01]),
        "image/jpeg"
      );
      expect(await stub.getIcon(k1)).not.toBeNull(); // k1/k2 still alive (only 2 in index)
      expect(await stub.getIcon(k3)).not.toBeNull();
    });
  });

  it("serves the gateway public JWKS at /.well-known/jwks.json", async () => {
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://localhost/.well-known/jwks.json"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age");
    const body = (await res.json()) as {
      keys: Array<{ kty: string; crv: string; kid: string; d?: string }>;
    };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    // Never leak the private scalar.
    expect(body.keys[0].d).toBeUndefined();
    expect(body.keys[0].kid).toBeTruthy();
  });
});
