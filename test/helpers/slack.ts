import { env } from "cloudflare:workers";

export async function slackHeaders(
  body: string,
  secret: string = env.SLACK_SIGNING_SECRET
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    enc.encode(`v0:${ts}:${body}`)
  );
  const hex = [...new Uint8Array(sig)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return {
    "Content-Type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": `v0=${hex}`
  };
}
