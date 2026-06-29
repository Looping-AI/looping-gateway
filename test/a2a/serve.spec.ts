import { describe, it, expect } from "vitest";
import { DefaultRequestHandler, InMemoryTaskStore } from "@a2a-js/sdk/server";
import { EchoExecutor } from "../echo-executor";
import { buildAgentCard } from "@/a2a/card";
import { serveA2A } from "@/a2a/serve";

function handler() {
  return new DefaultRequestHandler(
    buildAgentCard({ name: "Test Agent", description: "test" }),
    new InMemoryTaskStore(),
    new EchoExecutor()
  );
}

describe("serveA2A", () => {
  it("serves the agent card on the well-known path", async () => {
    const res = await serveA2A(
      new Request("https://agent.local/.well-known/agent-card.json"),
      handler()
    );
    expect(res.status).toBe(200);
    const card = (await res.json()) as {
      name: string;
      preferredTransport: string;
    };
    expect(card.name).toBe("Test Agent");
    expect(card.preferredTransport).toBe("JSONRPC");
  });

  it("echoes the user text via a message/send JSON-RPC call", async () => {
    const body = {
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: {
        message: {
          kind: "message",
          messageId: "m1",
          role: "user",
          parts: [{ kind: "text", text: "hello" }]
        }
      }
    };
    const res = await serveA2A(
      new Request("https://agent.local/a2a", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      }),
      handler()
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: { parts: { text: string }[] };
    };
    expect(json.result.parts[0].text).toBe("You said: hello");
  });

  it("404s on an unsupported method/path", async () => {
    const res = await serveA2A(
      new Request("https://agent.local/whatever", { method: "PUT" }),
      handler()
    );
    expect(res.status).toBe(404);
  });
});
