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
 * Matching is two-pass:
 *   1. Machine name — whole-token, case-insensitive, unambiguous.
 *   2. Display name — same token rules; if two channel agents share a display
 *      name, a user-visible message lists their machine names so the user can
 *      disambiguate (Pass 1 already handles machine-name mentions directly).
 * Without any mention, defaults to the single configured agent (or prompts the
 * user to specify when multiple agents are available).
 */
export async function resolveTarget(
  db: Db,
  input: ResolveInput
): Promise<Target> {
  const text = input.text;
  const channelEntries = await getAgentsForChannel(db, input.channelId);
  const ws = await getWorkspaceByAdminChannel(db, input.channelId);
  const isDm = isDmChannel(input.channelId);

  // Build all scoped candidate entries: channel-allowed agents + context-valid built-ins.
  let admin: AgentRow | null = null;
  let onboarding: AgentRow | null = null;
  const allEntries: AgentChannelEntry[] = [...channelEntries];

  if (ws) {
    admin = await getAgent(db, "admin");
    if (admin?.enabled) allEntries.push({ agent: admin, workspaceId: ws.id });
  }
  if (isDm) {
    onboarding = await getAgent(db, "onboarding");
    if (onboarding?.enabled)
      allEntries.push({ agent: onboarding, workspaceId: null });
  }

  const allEntriesByName = new Map<string, AgentChannelEntry>(
    allEntries.map((e) => [e.agent.name, e])
  );

  // Pass 1: machine name mention — unique, no ambiguity possible.
  const mention = findAgentNameMention(
    text,
    allEntries.map((e) => e.agent.name)
  );
  if (mention) {
    const entry = allEntriesByName.get(mention.name);
    if (entry)
      return {
        kind: "agent",
        agent: entry.agent,
        workspaceId: entry.workspaceId,
        text
      };
    return { kind: "none", reason: "mentioned agent unavailable" };
  }

  // Pass 2: display name mention — nullable, not guaranteed unique.
  const displayNameToEntries = new Map<string, AgentChannelEntry[]>();
  for (const entry of allEntries) {
    if (!entry.agent.displayName) continue;
    const key = entry.agent.displayName.toLowerCase();
    const existing = displayNameToEntries.get(key);
    if (existing) existing.push(entry);
    else displayNameToEntries.set(key, [entry]);
  }

  if (displayNameToEntries.size > 0) {
    const displayMention = findAgentNameMention(text, [
      ...displayNameToEntries.keys()
    ]);
    if (displayMention) {
      const candidates = displayNameToEntries.get(displayMention.name)!;
      if (candidates.length === 1) {
        const { agent, workspaceId } = candidates[0];
        return { kind: "agent", agent, workspaceId, text };
      }
      // Collision — ask the user to use a machine name instead.
      const names = candidates.map((c) => `\`${c.agent.name}\``).join(", ");
      return {
        kind: "none",
        reason: "ambiguous display name",
        userMessage: `Multiple agents match that name: ${names}. Mention one by machine name to address it directly.`
      };
    }
  }

  // No mention matched — use context defaults.

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
