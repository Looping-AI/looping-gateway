import type { AgentCard } from "@a2a-js/sdk";
import type { AgentExecutor } from "@a2a-js/sdk/server";
import { buildAgentCard } from "@/a2a/card";
import { A2AAgent } from "../base";
import { AdminAgentExecutor } from "./executor";

/** An avatar stored in this DO's key-value storage, served by `fetch`. */
interface StoredIcon {
  contentType: string;
  data: Uint8Array<ArrayBuffer>;
}

/** Storage key prefix + index key for the avatar map (see putIcon/getIcon). */
const ICON_PREFIX = "icon:";
const ICON_INDEX_KEY = "icon:index";
/** Keep the current + previous avatar so in-flight cached URLs don't 404. */
const ICON_KEEP = 2;

/**
 * Per-owner index key. The admin's own avatar keeps the legacy `icon:index` key
 * (unchanged behavior); each custom agent gets its own index so their avatars
 * don't evict one another under the {@link ICON_KEEP} cap.
 */
function iconIndexKey(owner: string): string {
  return owner === "self" ? ICON_INDEX_KEY : `${ICON_INDEX_KEY}:${owner}`;
}
/** Avatars are immutable per content-hash key; cache for a year (new image = new URL). */
const ICON_CACHE_CONTROL =
  "public, max-age=31536000, s-maxage=31536000, immutable";
const ICON_PATH = /^\/icons\/admin\/\d+\/([^/]+?)(?:\.\w+)?$/;

/**
 * Admin agent (registry + workspace management). One Durable Object instance per
 * workspace (`admin:{wsId}`), each with isolated Sessions + memory. Runs a
 * Workers-AI tool loop over registry/workspace CRUD tools gated by the caller's
 * auth context (carried on `message.metadata`).
 *
 * It also hosts avatars: the `self_write` (own avatar) and `agents_write`
 * `regenerate_avatar` (custom-agent avatars) tools generate an image via Workers AI
 * and persist it here via {@link putIcon}, keyed per owner; `fetch` serves it back so
 * Slack (and any A2A consumer) can fetch the agent's `iconUrl` over HTTP.
 */
export class AdminAgent extends A2AAgent {
  protected card(): AgentCard {
    return buildAgentCard({
      name: "Admin Agent",
      description:
        "Looping admin agent — manages the agent registry and workspaces."
    });
  }

  protected executor(): AgentExecutor {
    return new AdminAgentExecutor(this, this.env, {
      storeIcon: (img, owner) => this.putIcon(img.data, img.contentType, owner)
    });
  }

  /**
   * Persist an avatar in DO storage keyed by its content hash, prune the owner's
   * index to the last {@link ICON_KEEP}, and return the key. The hash key makes
   * the served URL effectively immutable (a regenerated image gets a new key ⇒
   * new URL). `owner` is `"self"` for the admin's own avatar or a custom agent's
   * name — each owner has its own index so avatars don't evict one another.
   *
   * NB: the `icon:{key}` store is shared across owners, so pruning one owner could
   * in theory delete a key another owner still references — only possible if two
   * agents produce a byte-identical image, which differing prompts make effectively
   * impossible.
   */
  async putIcon(
    data: Uint8Array<ArrayBuffer>,
    contentType: string,
    owner: string
  ): Promise<{ key: string; contentType: string }> {
    const digest = await crypto.subtle.digest("SHA-256", data);
    const key = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);

    const icon: StoredIcon = { contentType, data };
    await this.ctx.storage.put(ICON_PREFIX + key, icon);

    const indexKey = iconIndexKey(owner);
    const index = (await this.ctx.storage.get<string[]>(indexKey)) ?? [];
    const next = [...index.filter((k) => k !== key), key];
    while (next.length > ICON_KEEP) {
      const stale = next.shift();
      if (stale) await this.ctx.storage.delete(ICON_PREFIX + stale);
    }
    await this.ctx.storage.put(indexKey, next);

    return { key, contentType };
  }

  /** Read an avatar by its content-hash key (null when unknown/pruned). */
  async getIcon(key: string): Promise<StoredIcon | null> {
    const icon = await this.ctx.storage.get<StoredIcon>(ICON_PREFIX + key);
    return icon ?? null;
  }

  /**
   * Serve `/icons/admin/{wsId}/{key}` from storage; everything else is the A2A
   * protocol (card discovery + JSON-RPC) handled by the base class.
   */
  async fetch(request: Request): Promise<Response> {
    const match = new URL(request.url).pathname.match(ICON_PATH);
    if (request.method === "GET" && match) {
      const icon = await this.getIcon(match[1]);
      if (!icon) return new Response("not found", { status: 404 });
      return new Response(icon.data, {
        headers: {
          "content-type": icon.contentType,
          "cache-control": ICON_CACHE_CONTROL
        }
      });
    }
    return super.fetch(request);
  }
}
