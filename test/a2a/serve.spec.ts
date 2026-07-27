import { describe, it, expect } from "vitest";
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import {
  A2A_PROTOCOL_VERSION,
  A2A_VERSION_HEADER,
  Role,
  SendMessageRequest,
  TaskState
} from "@a2a-js/sdk";
import { A2A_ERROR_CODE } from "@a2a-js/sdk/errors";
import { EchoExecutor } from "../echo-executor";
import { buildAgentCard } from "@/a2a/card";
import { buildMessage, textPart } from "@/a2a/parts";
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
    eventBus.publish(
      AgentEvent.task({
        id: "task-xyz",
        contextId: requestContext.contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: undefined
        },
        artifacts: [],
        history: [],
        metadata: undefined
      })
    );
    eventBus.finished();
  };
  cancelTask = async (): Promise<void> => {};
}

/**
 * A v1.0 `SendMessage` envelope. The method name and the params encoding both
 * changed in v1.0 (`message/send` → `SendMessage`, params are protobuf-JSON),
 * so the params go through the generated encoder rather than a hand-written
 * literal.
 */
function sendBody() {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "SendMessage",
    params: SendMessageRequest.toJSON({
      tenant: "",
      message: buildMessage({
        messageId: "m1",
        role: Role.ROLE_USER,
        parts: [textPart("hello")]
      }),
      configuration: undefined,
      metadata: undefined
    })
  };
}

/** POST a JSON-RPC body, negotiating v1.0 unless `version` says otherwise. */
function post(body: unknown, version: string | null = A2A_PROTOCOL_VERSION) {
  return new Request("https://agent.local/a2a", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(version ? { [A2A_VERSION_HEADER]: version } : {})
    },
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
      supportedInterfaces: Array<{
        protocolBinding: string;
        protocolVersion: string;
      }>;
    };
    expect(card.name).toBe("Test Agent");
    // v1.0 advertises transports as an ordered `supportedInterfaces` list, each
    // entry pinning its own protocol binding and version.
    expect(card.supportedInterfaces[0]).toMatchObject({
      protocolBinding: "JSONRPC",
      protocolVersion: A2A_PROTOCOL_VERSION
    });
    expect(taskId).toBeUndefined();
  });

  it("echoes the user text via a SendMessage JSON-RPC call (message-shaped → no taskId)", async () => {
    const { response, taskId } = await serveA2A(post(sendBody()), handler());
    expect(response.status).toBe(200);
    // The result is the protobuf-JSON of SendMessageResponse: the payload oneof
    // surfaces as a single `message` key rather than an inline `kind`.
    const json = (await response.json()) as {
      result: { message: { parts: { text: string }[] } };
    };
    expect(json.result.message.parts[0].text).toBe("You said: hello");
    // Echo returns a Message, not a Task — no liveness barrier key to surface.
    expect(taskId).toBeUndefined();
  });

  it("surfaces the accepted Task id when SendMessage produces a Task", async () => {
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

  it("rejects a caller negotiating an unsupported protocol version", async () => {
    const { response, taskId } = await serveA2A(
      post(sendBody(), "0.3"),
      handler()
    );

    // JSON-RPC transports errors at HTTP 200; the envelope carries the code.
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(json.id).toBe(1);
    expect(json.error.code).toBe(A2A_ERROR_CODE.VERSION_NOT_SUPPORTED);
    expect(json.error.message).toContain("0.3");
    expect(taskId).toBeUndefined();
  });

  it("rejects a caller that omits the version header (treated as 0.3)", async () => {
    const { response } = await serveA2A(post(sendBody(), null), handler());
    const json = (await response.json()) as { error: { code: number } };
    expect(json.error.code).toBe(A2A_ERROR_CODE.VERSION_NOT_SUPPORTED);
  });
});
