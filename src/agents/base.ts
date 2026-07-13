import { Agent } from "agents";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  type AgentExecutor
} from "@a2a-js/sdk/server";
import { LocalPushNotificationSender } from "@/a2a/notifications/local";
import { serveA2A } from "@/a2a/serve";

/**
 * Base for in-repo agents. Each agent DO *is* its own A2A server: the gateway
 * reaches it via `stub.fetch`, and `fetch` here answers the A2A protocol
 * (card discovery + JSON-RPC) through the SDK's `DefaultRequestHandler`.
 *
 * Subclasses supply a `card()` and an `executor()`. Phase 3 executors just echo;
 * Phase 4 swaps in the AI-SDK loop. We extend the Agents SDK `Agent` (itself a
 * Durable Object) so executors can use `this.sql` for the Sessions API
 * (per-agent conversation history + writable memory). The A2A bridge is kept by
 * overriding `fetch` — these DOs are reached directly via `stub.fetch`, not
 * `routeAgentRequest`, so bypassing the SDK's default router is intentional.
 */
export abstract class A2AAgent extends Agent<Env> {
  private handler?: DefaultRequestHandler;

  protected abstract card(): AgentCard;
  protected abstract executor(): AgentExecutor;
  protected abstract builtinKind(): "admin" | "onboarding";

  private getHandler(): DefaultRequestHandler {
    if (!this.handler) {
      const card = this.card();
      const pushNotificationStore = new InMemoryPushNotificationStore();
      this.handler = new DefaultRequestHandler(
        card,
        new InMemoryTaskStore(),
        this.executor(),
        undefined,
        pushNotificationStore,
        new LocalPushNotificationSender(
          pushNotificationStore,
          this.builtinKind()
        )
      );
    }
    return this.handler;
  }

  async fetch(request: Request): Promise<Response> {
    return serveA2A(request, this.getHandler());
  }
}
