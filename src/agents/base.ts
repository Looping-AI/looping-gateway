import { Agent } from "agents";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryPushNotificationStore,
  InMemoryTaskStore,
  type AgentExecutor
} from "@a2a-js/sdk/server";
import type { LocalAgentKind } from "@/db/models/agents";
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
  private sender?: LocalPushNotificationSender;

  protected abstract card(): AgentCard;
  protected abstract executor(): AgentExecutor;
  protected abstract builtinKind(): LocalAgentKind;

  private getHandler(): DefaultRequestHandler {
    if (!this.handler) {
      const card = this.card();
      const pushNotificationStore = new InMemoryPushNotificationStore();
      this.sender = new LocalPushNotificationSender(
        pushNotificationStore,
        this.builtinKind()
      );
      this.handler = new DefaultRequestHandler(
        card,
        new InMemoryTaskStore(),
        this.executor(),
        undefined,
        pushNotificationStore,
        this.sender
      );
    }
    return this.handler;
  }

  async fetch(request: Request): Promise<Response> {
    const { response, taskId } = await serveA2A(request, this.getHandler());
    // Local agents accept-first (`blocking: false`): the SDK returns the
    // `submitted` accept immediately and runs the executor + push delivery as
    // background promises. Keep this DO alive until the accepted turn's terminal
    // reply is delivered — the accept carries its task id, so key the liveness
    // barrier on it. A request with no accepted task (card discovery, tasks/cancel)
    // has no pending turn, so fall back to draining any in-flight deliveries.
    if (this.sender) {
      this.ctx.waitUntil(
        taskId ? this.sender.whenSettled(taskId) : this.sender.drain()
      );
    }
    return response;
  }
}
