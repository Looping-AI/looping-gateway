/** Name of the Slack channel whose members are org-level admins. */
export const ORG_ADMIN_CHANNEL_NAME = "looping-org-admin";

/** Workers AI model used by all in-repo agents. Must support function calling. */
export const CHAT_MODEL_ID = "@cf/zai-org/glm-5.2";

/** Fallback model tried when the primary model throws an error. */
export const CHAT_FALLBACK_MODEL_ID = "@cf/google/gemma-4-26b-a4b-it";

/**
 * Workers AI embedding model for episodic recall (archived compacted history).
 * bge-m3 — multilingual (Slack channels are not English-only) with a long context
 * window. 1024-dimensional — must match the `agent-recall` Vectorize index dims.
 */
export const EMBED_MODEL_ID = "@cf/baai/bge-m3";

/** Cloudflare AI Gateway slug — "default" auto-provisions a gateway on first request. */
export const AI_GATEWAY_ID = "default";

/**
 * Comma-separated allowlist of hosts that custom (remote) A2A agents may be registered
 * on. Leave empty to permit any public HTTPS host (SSRF policy still applies).
 * Hosts are exact-matched against the endpoint's hostname (no port, no path, no wildcards).
 * Example: ["agent.example.com", "api.acme.io"]
 */
export const REMOTE_AGENT_ALLOWED_HOSTS: string[] = [];
