import { HITL_REQUEST_TTL_SECONDS } from "@/config";
import type { OpenCall, OpenCallStore } from "./open-call";

/** Key prefix for open calls; `hitl:open:{requestId}`. */
const OPEN_CALL_PREFIX = "hitl:open:";
const callKey = (requestId: string): string =>
  `${OPEN_CALL_PREFIX}${requestId}`;

/**
 * {@link OpenCallStore} over an agent Durable Object's own storage.
 *
 * Durable for the reason the task store is: a human may answer days later, long
 * after the isolate that asked has been evicted.
 */
export class DurableOpenCalls implements OpenCallStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  /**
   * Keep `call` until it is answered, and drop calls older than the HITL TTL
   * while here. A call stopped with 🛑 is never answered, so nothing else would
   * ever remove it.
   */
  async put(call: OpenCall): Promise<void> {
    await this.storage.put<OpenCall>(callKey(call.requestId), call);
    await this.prune();
  }

  /**
   * Hand the call `requestId` answers to `record`, and forget it only once
   * `record` has finished.
   *
   * The order is the point. Deleting first opens a window in which a reset of this
   * object loses an answer the gatekeeper has already marked as given and will not
   * send again. Recording first means the worst a reset can leave behind is a call
   * that was already answered, which the TTL prune removes. A `record` that throws
   * leaves the call where it was.
   */
  async settle(
    requestId: string,
    record: (call: OpenCall) => Promise<void>
  ): Promise<OpenCall | null> {
    const key = callKey(requestId);
    const call = await this.storage.get<OpenCall>(key);
    if (!call) return null;
    await record(call);
    await this.storage.delete(key);
    return call;
  }

  /**
   * One open call per paused turn, each gone within the TTL, so the set is small
   * by construction — listing it whole is fine here, unlike the task sweep.
   */
  private async prune(): Promise<void> {
    const cutoff = Date.now() - HITL_REQUEST_TTL_SECONDS * 1000;
    const calls = await this.storage.list<OpenCall>({
      prefix: OPEN_CALL_PREFIX
    });
    for (const [key, call] of calls) {
      if (call.createdAt < cutoff) await this.storage.delete(key);
    }
  }
}
