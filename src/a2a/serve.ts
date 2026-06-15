import { AGENT_CARD_PATH } from "@a2a-js/sdk";
import {
  JsonRpcTransportHandler,
  type A2ARequestHandler
} from "@a2a-js/sdk/server";

/**
 * Workers/Durable-Object fetch bridge for an A2A server. The official SDK only
 * ships an Express transport binding; this is the equivalent for `fetch`
 * (Request → Response), delegating to the SDK's transport-agnostic
 * `JsonRpcTransportHandler` + the agent's request handler.
 *
 * - `GET …/.well-known/agent-card.json` → the AgentCard (discovery).
 * - `POST`                              → JSON-RPC (`message/send`, etc.).
 *
 * Streaming (`message/stream`) is intentionally unsupported in the MVP — agents
 * advertise `capabilities.streaming: false`, so a single reply is returned.
 */
export async function serveA2A(
  request: Request,
  handler: A2ARequestHandler
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname.endsWith(AGENT_CARD_PATH)) {
    return Response.json(await handler.getAgentCard());
  }

  if (request.method === "POST") {
    const body = await request.json();
    const rpc = new JsonRpcTransportHandler(handler);
    const result = await rpc.handle(body);

    // Async generators are only returned for streaming methods, which we don't
    // advertise; reject rather than half-consume a stream.
    if (Symbol.asyncIterator in (result as object)) {
      return new Response("streaming not supported", { status: 501 });
    }
    return Response.json(result);
  }

  return new Response("not found", { status: 404 });
}
