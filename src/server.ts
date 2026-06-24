import { handleSlackEvent } from "@/slack-webhook-handler";
import { getPublicJwks } from "@/auth/agent-jwt";

// Cloudflare resolves Workflow + Durable Object class_names (wrangler.jsonc)
// from the entry module's exports.
export { MessageWorkflow } from "./workflows/message";
export { LifecycleWorkflow } from "./workflows/lifecycle";
export { ReconcileWorkflow } from "./workflows/reconcile";

// In-repo agents — each is its own A2A server. The Message Workflow reaches them
// in-process via their DO `stub.fetch` (see src/agents/dispatch.ts); they need no
// public HTTP route in Phase 3. Phase 3 echoes; Phase 4/5 add the AI loop + tools.
export { AdminAgent } from "./agents/admin";
export { OnboardingAgent } from "./agents/onboarding";

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    // Public JWKS — the gateway's Ed25519 signing public key(s). Remote (custom)
    // A2A agents fetch this to verify the gateway-identity JWT on each request.
    // Only public key material is ever exposed; no secret is shared.
    if (request.method === "GET" && url.pathname === "/.well-known/jwks.json") {
      return Response.json(getPublicJwks(env), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // Slack webhook ingest — verify the signature, classify the event, trigger
    // the matching durable Workflow, and ack within Slack's 3s budget. All agent
    // work happens asynchronously inside the Workflow, never inline here. The
    // gateway's public origin (JWT issuer/jku anchor) is discovered inside
    // handleSlackEvent, only after the Slack signature has been verified.
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
      const instance = await env.RECONCILE_WORKFLOW.create({});
      console.log("Reconciliation workflow triggered", {
        id: instance.id
      });
    } catch (err) {
      console.error("Reconciliation failed", err);
    }
  }
} satisfies ExportedHandler<Env>;
