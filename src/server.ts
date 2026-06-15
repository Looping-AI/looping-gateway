import { handleSlackEvent } from "@/slack-webhook-handler";
import { reconcile } from "@/services/reconcile";

// Cloudflare resolves Workflow + Durable Object class_names (wrangler.jsonc)
// from the entry module's exports.
export { MessageWorkflow } from "./workflows/message";
export { LifecycleWorkflow } from "./workflows/lifecycle";

// In-repo agents — each is its own A2A server. The Message Workflow reaches them
// in-process via their DO `stub.fetch` (see src/agents/dispatch.ts); they need no
// public HTTP route in Phase 3. Phase 3 echoes; Phase 4/5 add the AI loop + tools.
export { AdminAgent } from "./agents/admin";
export { OnboardingAgent } from "./agents/onboarding";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Slack webhook ingest — verify the signature, classify the event, trigger
    // the matching durable Workflow, and ack within Slack's 3s budget. All agent
    // work happens asynchronously inside the Workflow, never inline here.
    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvent(request, env);
    }

    return new Response("Not found", { status: 404 });
  },

  // Cron reconciliation (wrangler triggers.crons): the convergence backstop that
  // repairs registry drift against Slack reality. Errors are logged, not
  // rethrown — a failed run just retries on the next tick.
  async scheduled(_controller: ScheduledController, env: Env) {
    try {
      const result = await reconcile(env);
      console.log("Reconciliation complete", result);
    } catch (err) {
      console.error("Reconciliation failed", err);
    }
  }
} satisfies ExportedHandler<Env>;
