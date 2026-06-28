import type { Db } from "@/db/client";
import type { AgentRow } from "@/db/models/agents";
import {
  getAgent,
  getAgentsForChannel,
  type AgentChannelEntry
} from "@/db/models/agents";
import { getWorkspaceByAdminChannel } from "@/db/models/workspaces";
import { findAgentNameMention } from "./parse";

/** A resolved agent target plus the cleaned prompt and workspace scope. */
export interface ResolvedTarget {
  kind: "agent";
  agent: AgentRow;
  /** Workspace scope for the agent. */
  workspaceId: number | null;
  /** Original user text. */
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
 * A whole-token agent name mention selects which agent; if the named agent is
 * not permitted in the channel, `none` is returned with a user-visible
 * `userMessage`.
 * Without an agent name mention, defaults to the single configured agent (or
 * prompts the user to specify when multiple agents are available).
 */
export async function resolveTarget(
  db: Db,
  input: ResolveInput
): Promise<Target> {
  const text = input.text;
  const channelEntries = await getAgentsForChannel(db, input.channelId);
  const channelEntriesByName = new Map<string, AgentChannelEntry>(
    channelEntries.map((entry) => [entry.agent.name, entry])
  );

  const mentionCandidates = channelEntries.map((entry) => entry.agent.name);
  const ws = await getWorkspaceByAdminChannel(db, input.channelId);
  const isDm = isDmChannel(input.channelId);

  let admin: AgentRow | null = null;
  if (ws) {
    admin = await getAgent(db, "admin");
    if (admin?.enabled) mentionCandidates.push(admin.name);
  }

  let onboarding: AgentRow | null = null;
  if (isDm) {
    onboarding = await getAgent(db, "onboarding");
    if (onboarding?.enabled) mentionCandidates.push(onboarding.name);
  }

  const mention = findAgentNameMention(text, mentionCandidates);

  if (mention) {
    const channelEntry = channelEntriesByName.get(mention.name);
    if (channelEntry) {
      return {
        kind: "agent",
        agent: channelEntry.agent,
        workspaceId: channelEntry.workspaceId,
        text
      };
    }

    if (mention.name === "admin" && ws && admin?.enabled) {
      return { kind: "agent", agent: admin, workspaceId: ws.id, text };
    }

    if (mention.name === "onboarding" && isDm && onboarding?.enabled) {
      return { kind: "agent", agent: onboarding, workspaceId: null, text };
    }

    return { kind: "none", reason: "mentioned agent unavailable" };
  }

  // No agent name mention — use context defaults.

  // Admin channel → admin built-in.
  if (ws) {
    const adminAgent = admin ?? (await getAgent(db, "admin"));
    if (adminAgent?.enabled) {
      return { kind: "agent", agent: adminAgent, workspaceId: ws.id, text };
    }
    return { kind: "none", reason: "admin agent unavailable" };
  }

  // DM → onboarding built-in.
  if (isDm) {
    const onboardingAgent = onboarding ?? (await getAgent(db, "onboarding"));
    if (onboardingAgent?.enabled) {
      return {
        kind: "agent",
        agent: onboardingAgent,
        workspaceId: null,
        text
      };
    }
    return { kind: "none", reason: "onboarding agent unavailable" };
  }

  // Regular channel — check agent_channels.
  if (channelEntries.length === 0) {
    return { kind: "none", reason: "no agent configured for this context" };
  }
  if (channelEntries.length === 1) {
    return {
      kind: "agent",
      agent: channelEntries[0].agent,
      workspaceId: channelEntries[0].workspaceId,
      text
    };
  }
  // Multiple agents — ask the user to specify.
  const names = channelEntries.map((e) => `\`${e.agent.name}\``).join(", ");
  return {
    kind: "none",
    reason: "multiple agents configured, no agent name mentioned",
    userMessage: `Multiple agents are available here: ${names}. Mention one by name to address it directly.`
  };
}
