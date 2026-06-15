import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import type { Message } from "@a2a-js/sdk";
import { textOf } from "./parts";

/**
 * Phase-3 placeholder agent behavior: echo the user's text straight back as a
 * single agent message. Proves the full Slack → Workflow → A2A → reply loop
 * end-to-end without an LLM. Phase 4/5 replace this with the real AI-SDK loop.
 */
export class EchoExecutor implements AgentExecutor {
  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const input = textOf(requestContext.userMessage);
    const reply: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ kind: "text", text: `You said: ${input}` }],
      contextId: requestContext.contextId
    };
    eventBus.publish(reply);
    eventBus.finished();
  };

  // Echo is synchronous and stateless — nothing to cancel.
  cancelTask = async (): Promise<void> => {};
}
