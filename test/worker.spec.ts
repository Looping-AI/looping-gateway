import { describe, it, expect, vi } from "vitest";
import {
  env,
  createExecutionContext,
  waitOnExecutionContext
} from "cloudflare:test";

// Prevent the Slack adapter from making real API calls (auth.test) during DO initialization.
// Without this, onStart() blocks indefinitely waiting for the Slack API response.
vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: () => ({
    name: "slack",
    initialize: async () => {},
    handleWebhook: async () => new Response("ok", { status: 200 }),
    postMessage: async () => {}
  })
}));

import worker from "../src/server";

describe("Worker routing", () => {
  it("returns 404 for GET /", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://localhost/"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("returns 404 for unknown paths", async () => {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("http://localhost/some-unknown-path"),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(404);
  });

  it("handles Slack url_verification challenge", async () => {
    const ctx = createExecutionContext();
    const body = {
      type: "url_verification",
      challenge: "test-challenge-token-xyz"
    };
    const response = await worker.fetch(
      new Request("http://localhost/slack/events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }),
      env,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    const json: { challenge: string } = await response.json();
    expect(json.challenge).toBe("test-challenge-token-xyz");
  });
});
