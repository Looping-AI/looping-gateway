import { vi } from "vitest";

/**
 * Stub global fetch so the real callSlackApi/assertSlackOk/pagination code runs
 * against canned responses — vi.mock of modules doesn't intercept inside the
 * workerd pool, but the global fetch binding does. The handler receives the
 * Slack method (last URL path segment, e.g. "users.list") and the decoded
 * form body (so it can branch on `cursor`, `channel`, etc.). Call
 * vi.unstubAllGlobals() in afterEach to restore.
 */
export function stubSlack(
  handler: (method: string, body: URLSearchParams) => unknown
): void {
  vi.stubGlobal(
    "fetch",
    async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
      const method = new URL(url).pathname.split("/").pop() ?? "";
      const raw = typeof init?.body === "string" ? init.body : "";
      const payload = handler(method, new URLSearchParams(raw));
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  );
}
