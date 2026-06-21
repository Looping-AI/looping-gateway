import { handleSlackEvent } from "@/slack-webhook-handler";
import { reconcile } from "@/services/reconcile";
import { getPublicJwks } from "@/auth/agent-jwt";
import { getDb } from "@/db/client";
import { setConfig, SystemConfigKeys } from "@/db/models/workspace-configs";
import { ORG_WORKSPACE_ID } from "@/db/models/workspaces";

// The gateway's public origin, discovered from the first inbound request and
// memoized for the lifetime of this isolate. Resets to null on a new cold start
// (new deploy, domain change, etc.), triggering a fresh D1 write.
let cachedPublicUrl: string | null = null;

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
    // work happens asynchronously inside the Workflow, never inline here.
    if (request.method === "POST" && url.pathname === "/slack/events") {
      // Discover + persist the gateway's public origin on the first request of
      // each isolate. Set the cache synchronously before the await so concurrent
      // cold-start requests don't each trigger a write.
      if (cachedPublicUrl === null) {
        cachedPublicUrl = url.origin;
        await setConfig(
          getDb(env),
          ORG_WORKSPACE_ID,
          SystemConfigKeys.PUBLIC_URL,
          url.origin
        );
      }
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
