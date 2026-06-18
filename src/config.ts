/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "looping-org-admin";

/** Workers AI model used by all in-repo agents. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";
