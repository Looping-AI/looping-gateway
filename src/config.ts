/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "looping-org-admin";

/** Workers AI model used by all in-repo agents. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/moonshotai/kimi-k2.6";

/** Fallback model tried when the primary model is over capacity (AiError 3040). */
export const CHAT_FALLBACK_MODEL_ID = "@cf/openai/gpt-oss-120b";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";
