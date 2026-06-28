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
