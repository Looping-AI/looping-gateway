import {
  ClientFactory,
  ClientFactoryOptions,
  JsonRpcTransportFactory
} from "@a2a-js/sdk/client";
import type { AgentCard, Message, MessageSendParams } from "@a2a-js/sdk";
import { extractText } from "./parts";

/**
 * Where to send an A2A message:
 * - `local`  — a known card + a `fetchImpl` bound to a Durable Object `stub.fetch`,
 *   so card discovery is skipped and the call runs in-process (no network hop).
 * - `remote` — a base URL; the card is discovered over real HTTP (Phase 7).
 */
export type A2ATarget =
  | { kind: "local"; card: AgentCard; fetchImpl: typeof fetch }
  | { kind: "remote"; endpoint: string };

/**
 * Send one A2A message and return the agent's reply text. Uses the official
 * `@a2a-js/sdk` client; the JSON-RPC transport's `fetchImpl` is overridden for
 * local targets so requests land directly on the agent DO.
 */
export async function sendA2AMessage(
  target: A2ATarget,
  message: Message
): Promise<string> {
  const fetchImpl = target.kind === "local" ? target.fetchImpl : undefined;
  const options = ClientFactoryOptions.createFrom(
    ClientFactoryOptions.default,
    {
      transports: [new JsonRpcTransportFactory({ fetchImpl })]
    }
  );
  const factory = new ClientFactory(options);

  const client =
    target.kind === "local"
      ? await factory.createFromAgentCard(target.card)
      : await factory.createFromUrl(target.endpoint);

  const params: MessageSendParams = { message };
  const result = await client.sendMessage(params);
  return extractText(result);
}
