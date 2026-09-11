import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import type { OpenPrompt } from "@/agents/shared/open-prompt";
import { DurableOpenPrompts } from "@/agents/shared/open-prompt-store";

/**
 * Run against a real Durable Object's storage, one fresh instance per case so
 * nothing leaks between them.
 */
let instances = 0;
function withStorage<T>(
  fn: (storage: DurableObjectStorage) => Promise<T>
): Promise<T> {
  const name = `admin:open-prompts-${instances++}`;
  const stub = env.AdminAgent.get(env.AdminAgent.idFromName(name));
  return runInDurableObject(stub, (_agent, state) => fn(state.storage));
}

function prompt(requestId: string, createdAt = Date.now()): OpenPrompt {
  return {
    requestId,
    toolCallId: `tc-${requestId}`,
    toolName: "ask_user",
    input: { question: "Which environment?", options: [{ label: "dev" }] },
    createdAt
  };
}

describe("DurableOpenPrompts", () => {
  it("hands a prompt to a later instance over the same storage", async () => {
    await withStorage(async (storage) => {
      const kept = prompt("r1");
      await new DurableOpenPrompts(storage).put(kept);

      // The human answers days later, on an isolate that never saw the question.
      expect(await new DurableOpenPrompts(storage).take("r1")).toEqual(kept);
    });
  });

  it("gives a prompt out once: a second take of the same answer finds nothing", async () => {
    await withStorage(async (storage) => {
      const store = new DurableOpenPrompts(storage);
      await store.put(prompt("r1"));

      expect(await store.take("r1")).not.toBeNull();
      expect(await store.take("r1")).toBeNull();
    });
  });

  it("finds nothing for an id it never held", async () => {
    await withStorage(async (storage) => {
      expect(await new DurableOpenPrompts(storage).take("nope")).toBeNull();
    });
  });

  it("drops prompts past the HITL TTL when it keeps another", async () => {
    await withStorage(async (storage) => {
      // A prompt stopped with 🛑 is never answered, so nothing else removes it.
      const stale = prompt(
        "stale",
        Date.now() - (HITL_REQUEST_TTL_SECONDS + 60) * 1000
      );
      await storage.put(`hitl:open:${stale.requestId}`, stale);
      const store = new DurableOpenPrompts(storage);

      await store.put(prompt("fresh"));

      expect(await store.take("stale")).toBeNull();
      expect(await store.take("fresh")).not.toBeNull();
    });
  });
});
