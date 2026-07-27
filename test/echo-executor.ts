import { AgentEvent } from "@a2a-js/sdk/server";
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext
} from "@a2a-js/sdk/server";
import { Role } from "@a2a-js/sdk";
import { buildMessage, textOf, textPart } from "@/a2a/parts";

/**
 * Test stub agent behavior: echo the user's text straight back as a single
 * agent message. Used by serve.spec.ts to prove the A2A serve loop end-to-end
 * without an LLM.
 */
export class EchoExecutor implements AgentExecutor {
  execute = async (
    requestContext: RequestContext,
    eventBus: ExecutionEventBus
  ): Promise<void> => {
    const input = textOf(requestContext.userMessage);
    eventBus.publish(
      AgentEvent.message(
        buildMessage({
          messageId: crypto.randomUUID(),
          role: Role.ROLE_AGENT,
          parts: [textPart(`You said: ${input}`)],
          contextId: requestContext.contextId
        })
      )
    );
    eventBus.finished();
  };

  // Echo is synchronous and stateless — nothing to cancel.
  cancelTask = async (): Promise<void> => {};
}
