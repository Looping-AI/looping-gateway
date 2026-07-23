import { describe, it, expect } from "vitest";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import { EchoExecutor } from "../echo-executor";
import { buildAgentCard } from "@/a2a/card";
import { serveA2A } from "@/a2a/serve";

function handler(executor: AgentExecutor = new EchoExecutor()) {
  return new DefaultRequestHandler(
    buildAgentCard({ name: "Test Agent", description: "test" }),
    new InMemoryTaskStore(),
    executor
  );
}

/** Publishes a single completed Task (id "task-xyz") so the send result is task-shaped. */
class TaskExecutor implements AgentExecutor {
  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    eventBus.publish({
      kind: "task",
      id: "task-xyz",
      contextId: requestContext.contextId,
      status: { state: "completed" }
    });
    eventBus.finished();
  };
  cancelTask = async (): Promise<void> => {};
}

function sendBody() {
  return {
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
}

function post(body: unknown) {
  return new Request("https://agent.local/a2a", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("serveA2A", () => {
  it("serves the agent card on the well-known path (no taskId)", async () => {
    const { response, taskId } = await serveA2A(
      new Request("https://agent.local/.well-known/agent-card.json"),
      handler()
    );
    expect(response.status).toBe(200);
    const card = (await response.json()) as {
      name: string;
      preferredTransport: string;
    };
    expect(card.name).toBe("Test Agent");
    expect(card.preferredTransport).toBe("JSONRPC");
    expect(taskId).toBeUndefined();
  });

  it("echoes the user text via a message/send JSON-RPC call (message-shaped → no taskId)", async () => {
    const { response, taskId } = await serveA2A(post(sendBody()), handler());
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      result: { parts: { text: string }[] };
    };
    expect(json.result.parts[0].text).toBe("You said: hello");
    // Echo returns a Message, not a Task — no liveness barrier key to surface.
    expect(taskId).toBeUndefined();
  });

  it("surfaces the accepted Task id when message/send produces a Task", async () => {
    const { response, taskId } = await serveA2A(
      post(sendBody()),
      handler(new TaskExecutor())
    );
    expect(response.status).toBe(200);
    expect(taskId).toBe("task-xyz");
  });

  it("404s on an unsupported method/path (no taskId)", async () => {
    const { response, taskId } = await serveA2A(
      new Request("https://agent.local/whatever", { method: "PUT" }),
      handler()
    );
    expect(response.status).toBe(404);
    expect(taskId).toBeUndefined();
  });
});
