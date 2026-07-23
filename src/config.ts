/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "looping-org-admin";

/** Workers AI model used by all in-repo agents. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/moonshotai/kimi-k2.7-code";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/zai-org/glm-5.2";

/**
 * Workers AI text-to-image model for admin avatar generation. FLUX.2 [klein] 9B —
 * a first-party `@cf/` catalog model that returns a base64-encoded JPEG in `{ image }`,
 * which we decode to bytes before storing.
 */
export const AVATAR_IMAGE_MODEL_ID = "@cf/black-forest-labs/flux-2-klein-9b";

/**
 * Workers AI embedding model for episodic recall (archived compacted history).
 * bge-m3 — multilingual (Slack channels are not English-only) with a long context
 * window. 1024-dimensional — must match the `agent-recall` Vectorize index dims.
 */
export const EMBED_MODEL_ID = "@cf/baai/bge-m3";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * How long a human-in-the-loop prompt (an `input-required` task parked on a
 * Slack approval/question) stays open before the gateway expires it. On expiry
 * the maintenance sweep marks the request `expired`, updates the Slack message
 * to an expired state, and signals a timeout back onto the A2A task so the agent
 * can finalize. Fixed at 7 days: long enough that a genuine escalation is never
 * dropped over a weekend, bounded so parked rows don't linger indefinitely.
 */
export const HITL_REQUEST_TTL_SECONDS = 7 * 24 * 60 * 60;
