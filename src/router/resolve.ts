import type { Db } from "@/db/client";
import type { AgentRow } from "@/db/models/agents";
import {
  getAgent,
  getAgentsForChannel,
  getAgentInChannel
} from "@/db/models/agents";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import { cleanText, parseAgentRef } from "./parse";

/** A resolved agent target plus the cleaned prompt and workspace scope. */
export interface ResolvedTarget {
  kind: "agent";
  agent: AgentRow;
  /** Workspace scope for the agent. */
  workspaceId: number | null;
  /** User text with bot mention + `::ref` stripped. */
  text: string;
}

/**
 * No agent applies. `reason` is for logs; `userMessage` is the string to post
 * back to Slack (if omitted, the caller falls back to NO_AGENT_HINT).
 */
export interface NoTarget {
  kind: "none";
  reason: string;
  userMessage?: string;
}

export type Target = ResolvedTarget | NoTarget;

export interface ResolveInput {
  channelId: string;
  text: string;
}

/** Slack DM channel ids start with `D` (`C` = channel, `G` = group). */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith("D");
}

/**
 * Resolve which agent (if any) should handle a Slack message.
 *
 * Permission model:
 *   - Admin channels → `admin` built-in (no agent_channels row needed)
 *   - DMs            → `onboarding` built-in
 *   - Any channel    → agents with an agent_channels row for that channel
 *
 * `::name` selects which agent; if the named agent is not permitted in the
 * channel, `none` is returned with a user-visible `userMessage`.
 * Without `::name`, defaults to the single configured agent (or prompts the
 * user to specify when multiple agents are available).
 */
export async function resolveTarget(
  db: Db,
  input: ResolveInput
): Promise<Target> {
  const text = cleanText(input.text);
  const ref = parseAgentRef(input.text);

  if (ref) {
    // ::name ref given — look up the agent, then validate channel permission.
    const agent = await getAgent(db, ref);
    if (!agent?.enabled) {
      const result = {
        kind: "none" as const,
        reason: `unknown or disabled agent ::${ref}`
      };
      return result;
    }

    if (agent.kind === "admin") {
      const ws = await getWorkspaceByAdminChannel(db, input.channelId);
      if (!ws) {
        return {
          kind: "none",
          reason: `::${ref} not in admin channel`,
          userMessage: `\`::${ref}\` can only be used from a configured admin channel.`
        };
      }
      return { kind: "agent", agent, workspaceId: ws.id, text };
    }

    if (agent.kind === "onboarding") {
      if (!isDmChannel(input.channelId)) {
        return {
          kind: "none",
          reason: `::${ref} not in DM`,
          userMessage: `\`::${ref}\` is only available in direct messages.`
        };
      }
      return { kind: "agent", agent, workspaceId: null, text };
    }

    // Custom agent — must have an agent_channels row for this channel.
    const entry = await getAgentInChannel(db, input.channelId, ref);
    if (!entry) {
      return {
        kind: "none",
        reason: `::${ref} not configured for channel ${input.channelId}`,
        userMessage: `\`::${ref}\` is not configured for this channel.`
      };
    }
    return {
      kind: "agent",
      agent: entry.agent,
      workspaceId: entry.workspaceId,
      text
    };
  }

  // No ::name — use context defaults.

  // Admin channel → admin built-in.
  const ws = await getWorkspaceByAdminChannel(db, input.channelId);
  if (ws) {
    const admin = await getAgent(db, "admin");
    if (admin?.enabled) {
      return { kind: "agent", agent: admin, workspaceId: ws.id, text };
    }
    return { kind: "none", reason: "admin agent unavailable" };
  }

  // DM → onboarding built-in.
  if (isDmChannel(input.channelId)) {
    const onboarding = await getAgent(db, "onboarding");
    if (onboarding?.enabled) {
      return { kind: "agent", agent: onboarding, workspaceId: null, text };
    }
    return { kind: "none", reason: "onboarding agent unavailable" };
  }

  // Regular channel — check agent_channels.
  const entries = await getAgentsForChannel(db, input.channelId);
  if (entries.length === 0) {
    return { kind: "none", reason: "no agent configured for this context" };
  }
  if (entries.length === 1) {
    return {
      kind: "agent",
      agent: entries[0].agent,
      workspaceId: entries[0].workspaceId,
      text
    };
  }
  // Multiple agents — ask the user to specify.
  const names = entries.map((e) => `\`::${e.agent.name}\``).join(", ");
  return {
    kind: "none",
    reason: "multiple agents configured, no ::name given",
    userMessage: `Multiple agents are available here: ${names}. Use \`::agent-name\` to address one directly.`
  };
}
