import { DurableObject } from "cloudflare:workers";
import type { AgentCard } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor
} from "@a2a-js/sdk/server";
import { serveA2A } from "@/a2a/serve";

/**
 * Base for in-repo agents. Each agent DO *is* its own A2A server: the gateway
 * reaches it via `stub.fetch`, and `fetch` here answers the A2A protocol
 * (card discovery + JSON-RPC) through the SDK's `DefaultRequestHandler`.
 *
 * Subclasses supply a `card()` and an `executor()`. Phase 3 executors just echo;
 * Phase 4/5 swap in the AI-SDK loop. This is a plain `DurableObject` (not the
 * Agents SDK `Agent`) for a small, fully-testable surface — it can later extend
 * `Agent` under the same class name + SQLite storage with no migration.
 */
export abstract class A2AAgent extends DurableObject<Env> {
  private handler?: DefaultRequestHandler;

  protected abstract card(): AgentCard;
  protected abstract executor(): AgentExecutor;

  private getHandler(): DefaultRequestHandler {
    if (!this.handler) {
      this.handler = new DefaultRequestHandler(
        this.card(),
        new InMemoryTaskStore(),
        this.executor()
      );
    }
    return this.handler;
  }

  async fetch(request: Request): Promise<Response> {
    return serveA2A(request, this.getHandler());
  }
}
