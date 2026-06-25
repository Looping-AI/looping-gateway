import { afterEach, describe, it, expect, vi } from "vitest";
import { resolveChannelName } from "@/slack/channel-cache";
import { stubSlack } from "../wrappers/slack-stub";

afterEach(() => vi.unstubAllGlobals());

/** Minimal in-memory KV so the cache contents can be asserted directly. */
function fakeKv() {
  const store = new Map<string, string>();
  const kv = {
    get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
    put: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    })
  };
  return { store, kv };
}

function makeEnv(kv: ReturnType<typeof fakeKv>["kv"]) {
  return { GATEWAY_CACHE: kv, SLACK_BOT_TOKEN: "xoxb-test" } as unknown as Env;
}

describe("resolveChannelName", () => {
  it("returns a cached hit without calling Slack", async () => {
    const { kv, store } = fakeKv();
    store.set("chan:C1", "general");
    let fetched = false;
    stubSlack(() => {
      fetched = true;
      return { ok: true };
    });

    expect(await resolveChannelName(makeEnv(kv), "C1")).toBe("general");
    expect(fetched).toBe(false);
  });

  it("fetches conversations.info on a miss and caches the name with a TTL", async () => {
    const { kv, store } = fakeKv();
    stubSlack((method, body) => {
      expect(method).toBe("conversations.info");
      expect(body.get("channel")).toBe("C2");
      return { ok: true, channel: { id: "C2", name: "random" } };
    });

    expect(await resolveChannelName(makeEnv(kv), "C2")).toBe("random");
    expect(kv.put).toHaveBeenCalledWith("chan:C2", "random", {
      expirationTtl: expect.any(Number)
    });
    expect(store.get("chan:C2")).toBe("random");
  });

  it("caches an empty-string sentinel for DMs and short-circuits the next lookup", async () => {
    const { kv, store } = fakeKv();
    let calls = 0;
    stubSlack(() => {
      calls++;
      return { ok: true, channel: { id: "D1", is_im: true } };
    });
    const env = makeEnv(kv);

    expect(await resolveChannelName(env, "D1")).toBeNull();
    expect(store.get("chan:D1")).toBe("");
    // Second call hits the sentinel — no further Slack call.
    expect(await resolveChannelName(env, "D1")).toBeNull();
    expect(calls).toBe(1);
  });

  it("returns null and does not cache when Slack errors", async () => {
    const { kv, store } = fakeKv();
    stubSlack(() => ({ ok: false, error: "missing_scope" }));

    expect(await resolveChannelName(makeEnv(kv), "C3")).toBeNull();
    expect(store.has("chan:C3")).toBe(false);
  });
});
