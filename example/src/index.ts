import { AGENT_CARD_PATH, type Message, type Part } from "@a2a-js/sdk";
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  JsonRpcTransportHandler,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from "@a2a-js/sdk/server";
import { buildBaseCard, publicCardJwks, signCard } from "./card";
import {
  GatewayAuthError,
  bearerToken,
  verifyGatewayToken,
  type GatewayIdentity
} from "./verify";

/**
 * Reference remote A2A agent for looping-gateway (Phase 7).
 *
 * Demonstrates the full zero-trust, no-shared-secrets contract a third-party
 * custom agent must implement:
 *
 *  1. Serve a **signed** AgentCard at `…/.well-known/agent-card.json` so the
 *     gateway can verify+pin the agent's identity at registration ("A knows B").
 *  2. Publish the card-signing **public** JWKS at the card's `jku`.
 *  3. **Verify the gateway's identity JWT** on every JSON-RPC call against the
 *     gateway's public JWKS ("B knows A"), then echo the caller's message.
 *
 * No secret is ever shared between the gateway and this agent — trust flows
 * entirely through asymmetric (Ed25519) signatures over public JWKS.
 */

interface Env {
  /** Ed25519 private JWK (with `kid`) used to sign this agent's AgentCard. */
  CARD_SIGNING_PRIVATE_KEY: string;
  /** Issuer the gateway uses (`iss`) — must match `PUBLIC_URL` on the gateway. */
  EXPECTED_ISSUER: string;
  /** Optional explicit audience; defaults to this worker's request origin. */
  EXPECTED_AUDIENCE?: string;
}

/** Path serving this agent's card-signing public JWKS (the card's `jku`). */
const JWKS_PATH = "/.well-known/jwks.json";

/** Concatenate the text parts of an inbound A2A message. */
function textOf(message: Message): string {
  return (message.parts ?? [])
    .filter(
      (p: Part): p is Extract<Part, { kind: "text" }> => p.kind === "text"
    )
    .map((p) => p.text)
    .join("")
    .trim();
}

/** Echo executor that greets the verified caller by name (from the JWT claims). */
class EchoExecutor implements AgentExecutor {
  constructor(private readonly identity: GatewayIdentity) {}

  execute = async (
    ctx: RequestContext,
    bus: ExecutionEventBus
  ): Promise<void> => {
    const said = textOf(ctx.userMessage);
    const who =
      this.identity.displayName ||
      this.identity.slackUserId ||
      "unknown caller";
    const reply: Message = {
      kind: "message",
      messageId: crypto.randomUUID(),
      role: "agent",
      parts: [{ kind: "text", text: `Hello ${who}, you said: ${said}` }],
      contextId: ctx.contextId
    };
    bus.publish(reply);
    bus.finished();
  };

  cancelTask = async (): Promise<void> => {};
}

function unauthorized(reason: string): Response {
  return new Response(`unauthorized: ${reason}`, {
    status: 401,
    headers: { "www-authenticate": 'Bearer error="invalid_token"' }
  });
}

function parsePrivateJwk(
  raw: string
): Parameters<typeof signCard>[1]["privateJwk"] {
  const jwk = JSON.parse(raw) as { kid?: string };
  if (!jwk.kid)
    throw new Error("CARD_SIGNING_PRIVATE_KEY must include a `kid`");
  return jwk as Parameters<typeof signCard>[1]["privateJwk"];
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const privateJwk = parsePrivateJwk(env.CARD_SIGNING_PRIVATE_KEY);

    // (2) Card-signing public JWKS — resolves the card's `jku` for the gateway.
    if (request.method === "GET" && url.pathname === JWKS_PATH) {
      return Response.json(publicCardJwks(privateJwk), {
        headers: { "cache-control": "public, max-age=3600" }
      });
    }

    // (1) Signed AgentCard discovery.
    if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
      const card = await signCard(buildBaseCard(origin), {
        privateJwk,
        jku: `${origin}${JWKS_PATH}`
      });
      return Response.json(card);
    }

    // (3) A2A JSON-RPC — gateway-authenticated only.
    if (request.method === "POST") {
      const token = bearerToken(request);
      if (!token) return unauthorized("missing gateway bearer token");

      let identity: GatewayIdentity;
      try {
        ({ identity } = await verifyGatewayToken(token, {
          issuer: env.EXPECTED_ISSUER,
          audience: env.EXPECTED_AUDIENCE ?? origin
        }));
      } catch (err) {
        const message =
          err instanceof GatewayAuthError ? err.message : "verification failed";
        return unauthorized(message);
      }

      const body = await request.json();
      const handler = new DefaultRequestHandler(
        buildBaseCard(origin),
        new InMemoryTaskStore(),
        new EchoExecutor(identity)
      );
      const rpc = new JsonRpcTransportHandler(handler);
      const result = await rpc.handle(body);

      // We don't advertise streaming; reject async generators outright.
      if (Symbol.asyncIterator in (result as object)) {
        return new Response("streaming not supported", { status: 501 });
      }
      return Response.json(result);
    }

    return new Response("not found", { status: 404 });
  }
} satisfies ExportedHandler<Env>;
