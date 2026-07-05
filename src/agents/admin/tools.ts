import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { authorize, type UserAuthContext } from "@/auth";
import type { CardSigningPin, VerifiedAgentCard } from "@/a2a/card-verify";
import {
  type AgentRow,
  type NotifyOn,
  getAgent,
  getAgentChannels,
  listAgentsForWorkspace,
  listChannelsForAgents,
  registerAgent,
  updateAgent,
  unregisterAgent,
  attachAgentChannel,
  detachAgentChannel
} from "@/db/models/agents";
import {
  ORG_WORKSPACE_ID,
  getWorkspace,
  listWorkspaces,
  createWorkspace,
  setWorkspaceAdminChannel
} from "@/db/models/workspaces";
import {
  getAllowedRemoteAgentDomains,
  setAllowedRemoteAgentDomains,
  getPublicUrl,
  setAdminIconUrl,
  setAdminDisplayName
} from "@/db/models/workspace-configs";
import { SHARED_INFRA_ROOTS } from "@/a2a/endpoint";
import {
  buildAvatarPrompt,
  buildAgentAvatarPrompt,
  type GeneratedImage
} from "./avatar";

/**
 * Admin tools — registry + workspace CRUD on D1. Consolidated to read/write per
 * domain (no tool proliferation): `agents_read`, `agents_write`, `workspace_read`,
 * `workspace_write`, `remote_agent_domains`, and `self_write` (the admin's own
 * avatar + display name). Writes use a discriminated `operation`.
 *
 * Two gating layers (see PLAN Phase 4):
 *  1. Instance-scoped availability — `buildAdminTools` only constructs
 *     `workspace_write` on the org instance (`wsId === ORG_WORKSPACE_ID`); a
 *     workspace instance never receives it. `agents_*` act on the instance's wsId.
 *  2. Per-call `authorize()` defense-in-depth — the caller must be an admin of
 *     the instance's workspace (established by admin-channel membership).
 *
 * Tool *logic* is split from the AI-SDK wiring so it unit-tests without an LLM.
 */
export interface AdminToolDeps {
  ctx: UserAuthContext | null;
  /** The workspace this admin instance manages (admin:{wsId}). */
  wsId: number;
  /**
   * Validates a custom agent's endpoint (SSRF policy) and verifies its signed
   * AgentCard, returning the signing identity to pin. Injected so the pure
   * handlers stay offline-testable; production binds it to the live verifier.
   */
  verifyEndpoint: EndpointVerifier;
  /**
   * Generate an avatar image from a prompt (Workers AI). Injected side-effect
   * seam — present only in production. When this or {@link storeIcon} is absent,
   * avatar generation (self_write `set_avatar` and agents_write
   * `regenerate_avatar`) returns a "not available" error at runtime.
   */
  generateImage?: (prompt: string) => Promise<GeneratedImage>;
  /**
   * Persist a generated avatar in the admin DO storage; returns its key. `name`
   * is `"admin"` (the admin's own avatar) or a custom agent's name — icons are
   * pruned per agent.
   */
  storeIcon?: (
    img: GeneratedImage,
    name: string
  ) => Promise<{ key: string; contentType: string }>;
}

/** Verify a remote agent endpoint + signed card; resolves to pin and card-derived metadata. */
export type EndpointVerifier = (endpoint: string) => Promise<VerifiedAgentCard>;

// CardSigningPin is re-exported so existing imports from this module keep working.
export type { CardSigningPin };

/** A reserved/built-in agent name that registry CRUD must never touch. */
const RESERVED_NAMES = new Set(["admin", "onboarding"]);

type ToolResult = Record<string, unknown>;

function deny(reason: string): ToolResult {
  return { error: `Not authorized: ${reason}` };
}

function shape(a: AgentRow, channels: string[]): ToolResult {
  return {
    name: a.name,
    kind: a.kind,
    displayName: a.displayName,
    iconUrl: a.iconUrl,
    enabled: a.enabled,
    notifyOn: a.notifyOn,
    a2aEndpoint: a.a2aEndpoint,
    workspaceId: a.workspaceId,
    channels
  };
}

/** Shape an agent row for the model (small, with its channel attachments). */
async function present(a: AgentRow): Promise<ToolResult> {
  return shape(a, await getAgentChannels(a.name));
}

/** Resolve a write target: must exist, belong to this workspace, and be a custom agent. */
async function requireWritableAgent(
  deps: AdminToolDeps,
  name: string
): Promise<AgentRow | { error: string }> {
  if (RESERVED_NAMES.has(name)) {
    return { error: `"${name}" is a built-in agent and cannot be modified.` };
  }
  const a = await getAgent(name);
  if (!a || a.workspaceId !== deps.wsId) {
    return { error: `No agent "${name}" in workspace ${deps.wsId}.` };
  }
  if (a.kind !== "custom") {
    return { error: `"${name}" is a built-in agent and cannot be modified.` };
  }
  return a;
}

// ---------------------------------------------------------------------------
// Pure handlers (exported for tests) — return JSON-serializable results.
// ---------------------------------------------------------------------------

export async function agentsRead(
  deps: AdminToolDeps,
  args: { name?: string }
): Promise<ToolResult> {
  if (!deps.ctx) return deny("sign in as an admin to read agents");
  if (
    !authorize(deps.ctx, { type: "IsWorkspaceAdmin", workspaceId: deps.wsId })
  )
    return deny(`reading agents requires admin of workspace ${deps.wsId}`);

  if (args.name) {
    const a = await getAgent(args.name);
    return {
      agents: a && a.workspaceId === deps.wsId ? [await present(a)] : []
    };
  }
  const rows = await listAgentsForWorkspace(deps.wsId);
  const channelRows = await listChannelsForAgents(rows.map((r) => r.name));
  const byAgent = new Map<string, string[]>();
  for (const { agentName, channelId } of channelRows) {
    const entry = byAgent.get(agentName);
    if (entry) entry.push(channelId);
    else byAgent.set(agentName, [channelId]);
  }
  return { agents: rows.map((a) => shape(a, byAgent.get(a.name) ?? [])) };
}

export type AgentsWriteArgs =
  | {
      operation: "register";
      name: string;
      displayName?: string;
      a2aEndpoint: string;
      notifyOn: NotifyOn;
    }
  | {
      operation: "update";
      name: string;
      displayName?: string;
      enabled?: boolean;
      a2aEndpoint?: string;
      notifyOn?: NotifyOn;
    }
  | { operation: "add_channel"; name: string; channelId: string }
  | { operation: "remove_channel"; name: string; channelId: string }
  | { operation: "regenerate_avatar"; name: string; instructions?: string }
  | { operation: "unregister"; name: string };

export async function agentsWrite(
  deps: AdminToolDeps,
  args: AgentsWriteArgs
): Promise<ToolResult> {
  if (!deps.ctx) return deny("sign in as an admin to manage agents");
  if (
    !authorize(deps.ctx, { type: "IsWorkspaceAdmin", workspaceId: deps.wsId })
  )
    return deny(`managing agents requires admin of workspace ${deps.wsId}`);

  switch (args.operation) {
    case "register": {
      if (RESERVED_NAMES.has(args.name))
        return { error: `"${args.name}" is a reserved built-in agent name.` };
      if (await getAgent(args.name))
        return { error: `An agent named "${args.name}" already exists.` };
      let verified: VerifiedAgentCard;
      try {
        verified = await deps.verifyEndpoint(args.a2aEndpoint);
      } catch (err) {
        return {
          error: `Endpoint verification failed: ${(err as Error).message}`
        };
      }
      const row = await registerAgent({
        name: args.name,
        kind: "custom",
        displayName: args.displayName ?? verified.displayName,
        // No icon at registration — a custom agent's avatar is gateway-hosted and
        // set later by the admin via `regenerate_avatar` (never sourced from the card).
        a2aEndpoint: args.a2aEndpoint,
        notifyOn: args.notifyOn,
        workspaceId: deps.wsId,
        cardSigningJku: verified.pin.cardSigningJku,
        cardSigningKid: verified.pin.cardSigningKid
      });
      return { ok: true, agent: await present(row) };
    }
    case "update": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      // A re-pointed endpoint is re-verified and must keep the SAME pinned
      // signing identity (Trust-On-First-Use) — a different signer is rejected.
      // `displayName` is refreshed from the new card unless the caller explicitly
      // overrides it here. `iconUrl` is NOT touched — the avatar is gateway-hosted
      // and admin-generated, so it survives endpoint changes.
      let verified: VerifiedAgentCard | undefined;
      if (
        args.a2aEndpoint !== undefined &&
        args.a2aEndpoint !== target.a2aEndpoint
      ) {
        try {
          verified = await deps.verifyEndpoint(args.a2aEndpoint);
        } catch (err) {
          return {
            error: `Endpoint verification failed: ${(err as Error).message}`
          };
        }
        if (
          target.cardSigningKid &&
          (verified.pin.cardSigningKid !== target.cardSigningKid ||
            verified.pin.cardSigningJku !== target.cardSigningJku)
        ) {
          return {
            error:
              `New endpoint for "${args.name}" is signed by a different key than the ` +
              `one pinned at registration. Unregister and re-register if the agent's ` +
              `signing identity changed intentionally.`
          };
        }
      }
      await updateAgent(args.name, {
        displayName:
          args.displayName !== undefined
            ? args.displayName
            : verified?.displayName,
        enabled: args.enabled,
        a2aEndpoint: args.a2aEndpoint,
        notifyOn: args.notifyOn,
        ...(verified
          ? {
              cardSigningJku: verified.pin.cardSigningJku,
              cardSigningKid: verified.pin.cardSigningKid
            }
          : {})
      });
      const updated = await getAgent(args.name);
      return {
        ok: true,
        agent: updated ? await present(updated) : null
      };
    }
    case "add_channel": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await attachAgentChannel({
        agentName: args.name,
        channelId: args.channelId,
        workspaceId: deps.wsId
      });
      return { ok: true, agent: await present(target) };
    }
    case "remove_channel": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await detachAgentChannel(args.name, args.channelId);
      return { ok: true, agent: await present(target) };
    }
    case "regenerate_avatar": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      const prompt = buildAgentAvatarPrompt({
        agentName: target.name,
        displayName: target.displayName,
        instructions: args.instructions
      });
      const result = await generateAndStoreIcon(deps, target.name, prompt);
      if ("error" in result) return result;
      await updateAgent(args.name, { iconUrl: result.iconUrl });
      const updated = await getAgent(args.name);
      return {
        ok: true,
        agent: updated ? await present(updated) : null,
        note: `Avatar generated for "${args.name}" — it appears on the agent's next reply.`
      };
    }
    case "unregister": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await unregisterAgent(args.name);
      return { ok: true, unregistered: args.name };
    }
  }
}

export async function workspaceRead(
  deps: AdminToolDeps,
  args: { id?: number }
): Promise<ToolResult> {
  if (!deps.ctx) return deny("sign in as an admin to read workspaces");
  if (
    !authorize(deps.ctx, { type: "IsWorkspaceAdmin", workspaceId: deps.wsId })
  )
    return deny(`reading workspaces requires admin of workspace ${deps.wsId}`);

  const isOrg = deps.wsId === ORG_WORKSPACE_ID;
  if (args.id !== undefined) {
    if (!isOrg && args.id !== deps.wsId)
      return deny(`you can only read workspace ${deps.wsId}`);
    const ws = await getWorkspace(args.id);
    return { workspaces: ws ? [ws] : [] };
  }
  if (isOrg) return { workspaces: await listWorkspaces() };
  const ws = await getWorkspace(deps.wsId);
  return { workspaces: ws ? [ws] : [] };
}

export type WorkspaceWriteArgs =
  | { operation: "create"; name: string }
  | { operation: "set_admin_channel"; id: number; channelId: string };

export async function workspaceWrite(
  deps: AdminToolDeps,
  args: WorkspaceWriteArgs
): Promise<ToolResult> {
  // Belt-and-suspenders: this tool is only built on admin:0, but enforce anyway.
  if (deps.wsId !== ORG_WORKSPACE_ID)
    return deny("workspace management is only available to the org admin");
  if (!deps.ctx) return deny("sign in as the org admin to manage workspaces");
  if (
    !authorize(deps.ctx, {
      type: "IsWorkspaceAdmin",
      workspaceId: ORG_WORKSPACE_ID
    })
  )
    return deny("workspace management requires org admin");

  switch (args.operation) {
    case "create": {
      const ws = await createWorkspace({ name: args.name });
      return { ok: true, workspace: ws };
    }
    case "set_admin_channel": {
      if (!(await getWorkspace(args.id)))
        return { error: `Workspace ${args.id} not found.` };
      await setWorkspaceAdminChannel(args.id, args.channelId);
      return { ok: true, workspace: await getWorkspace(args.id) };
    }
  }
}

// ---------------------------------------------------------------------------
// AI-SDK tool wiring — thin wrappers over the handlers above.
// ---------------------------------------------------------------------------
// remote_agent_domains — org-only
// ---------------------------------------------------------------------------

type RemoteAgentDomainsArgs =
  | { operation: "list" }
  | { operation: "add"; domain: string }
  | { operation: "remove"; domain: string };

export async function remoteAgentDomains(
  deps: AdminToolDeps,
  args: RemoteAgentDomainsArgs
): Promise<ToolResult> {
  if (deps.wsId !== ORG_WORKSPACE_ID)
    return deny(
      "remote agent domain management is only available to the org admin"
    );
  if (!deps.ctx)
    return deny("sign in as the org admin to manage remote agent domains");
  if (
    !authorize(deps.ctx, {
      type: "IsWorkspaceAdmin",
      workspaceId: ORG_WORKSPACE_ID
    })
  )
    return deny("remote agent domain management requires org admin");

  const current = await getAllowedRemoteAgentDomains();

  if (args.operation === "list") {
    return {
      approvedDomains: current,
      note:
        "Each entry covers that domain and all its subdomains. " +
        "An empty list means no custom (remote) agents are approved."
    };
  }

  const rawDomain = args.domain.trim().toLowerCase();

  // Strip any scheme/path/port the caller may have included.
  let domain: string;
  try {
    const parsed = rawDomain.includes("://")
      ? new URL(rawDomain).hostname
      : new URL(`https://${rawDomain}`).hostname;
    domain = parsed;
  } catch {
    return { error: `'${args.domain}' is not a valid domain.` };
  }

  if (!domain || !domain.includes(".")) {
    return {
      error: `'${args.domain}' must be a multi-label domain (e.g. 'agents.example.com').`
    };
  }

  if (SHARED_INFRA_ROOTS.has(domain)) {
    return {
      error:
        `'${domain}' is a shared infrastructure root domain — any third-party ` +
        `can deploy under it and forge agent identities in A2A key verification. ` +
        `Add a specific account-level subdomain you control instead ` +
        `(e.g. 'myorg.${domain}').`
    };
  }

  if (args.operation === "add") {
    if (current.includes(domain)) {
      return {
        ok: true,
        approvedDomains: current,
        note: `'${domain}' was already approved.`
      };
    }
    const updated = [...current, domain];
    await setAllowedRemoteAgentDomains(updated);
    return {
      ok: true,
      approvedDomains: updated,
      note:
        `'${domain}' and all its subdomains are now approved for remote agents. ` +
        `Only add domains your organization fully controls.`
    };
  }

  // operation === "remove"
  if (!current.includes(domain)) {
    return {
      ok: true,
      approvedDomains: current,
      note: `'${domain}' was not in the approved list.`
    };
  }
  const updated = current.filter((d) => d !== domain);
  await setAllowedRemoteAgentDomains(updated);
  return { ok: true, approvedDomains: updated };
}

// ---------------------------------------------------------------------------
// Avatar generation — shared by the admin self-avatar and custom-agent avatars.
// ---------------------------------------------------------------------------

/**
 * Generate an avatar image and persist it in the admin DO under `name`, returning
 * its public gateway URL (`/icons/{wsId}/{name}/{key}.jpg`, served by the admin DO).
 * Guards the image seams and the public-URL precondition. Shared by the admin's own
 * avatar (`name === "admin"`) and custom-agent avatars (`name === agent name`).
 */
async function generateAndStoreIcon(
  deps: AdminToolDeps,
  name: string,
  prompt: string
): Promise<{ iconUrl: string } | { error: string }> {
  if (!deps.generateImage || !deps.storeIcon)
    return { error: "Avatar generation is not available in this environment." };

  const publicUrl = await getPublicUrl();
  if (!publicUrl)
    return {
      error:
        "The gateway's public URL isn't known yet (it's discovered after the " +
        "first Slack event). Try again shortly."
    };

  let stored: { key: string; contentType: string };
  try {
    const img = await deps.generateImage(prompt);
    stored = await deps.storeIcon(img, name);
  } catch (err) {
    return { error: `Avatar generation failed: ${(err as Error).message}` };
  }

  if (stored.contentType !== "image/jpeg")
    throw new Error(`Unexpected avatar content type: ${stored.contentType}`);
  return {
    iconUrl: `${publicUrl}/icons/${deps.wsId}/${name}/${stored.key}.jpg`
  };
}

// ---------------------------------------------------------------------------
// self_write — the admin agent mutates its OWN identity (avatar, display name).
// ---------------------------------------------------------------------------

export type SelfWriteArgs =
  | { operation: "set_avatar"; instructions?: string }
  | { operation: "set_display_name"; displayName: string };

export async function selfWrite(
  deps: AdminToolDeps,
  args: SelfWriteArgs
): Promise<ToolResult> {
  if (!deps.ctx) return deny("sign in as an admin to change your own identity");
  if (
    !authorize(deps.ctx, { type: "IsWorkspaceAdmin", workspaceId: deps.wsId })
  )
    return deny(
      `changing the admin agent's identity requires admin of workspace ${deps.wsId}`
    );

  switch (args.operation) {
    case "set_avatar": {
      const ws = await getWorkspace(deps.wsId);
      const workspaceName = ws?.name ?? `workspace ${deps.wsId}`;
      const prompt = buildAvatarPrompt({
        workspaceName,
        instructions: args.instructions
      });
      const result = await generateAndStoreIcon(deps, "admin", prompt);
      if ("error" in result) return result;
      await setAdminIconUrl(deps.wsId, result.iconUrl);
      return {
        ok: true,
        iconUrl: result.iconUrl,
        note: "Avatar regenerated — it appears on the admin agent's next reply."
      };
    }
    case "set_display_name": {
      const displayName = args.displayName.trim();
      if (!displayName) return { error: "Display name cannot be empty." };
      await setAdminDisplayName(deps.wsId, displayName);
      return {
        ok: true,
        displayName,
        note: "Display name updated — it appears on the admin agent's next reply."
      };
    }
  }
}

// ---------------------------------------------------------------------------

/** Build the admin tool set for one instance. `workspace_write` is org-only. */
export function buildAdminTools(deps: AdminToolDeps): ToolSet {
  const tools: ToolSet = {
    agents_read: tool({
      description:
        "List or look up agents in this workspace. Omit `name` to list all.",
      inputSchema: z.object({
        name: z.string().optional().describe("Exact agent name to look up")
      }),
      execute: (args) => agentsRead(deps, args)
    }),
    agents_write: tool({
      description:
        "Create, update, or remove a custom agent in this workspace. " +
        "Use operation=update to change fields; add_channel/remove_channel to " +
        "manage one channel at a time; regenerate_avatar to AI-generate a new " +
        "avatar for the agent. Built-in admin/onboarding agents cannot be modified.",
      inputSchema: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("register"),
          name: z
            .string()
            .regex(
              /^[a-z0-9_-]+$/,
              "Agent name must be a lowercase slug (a-z, 0-9, _ or -)"
            )
            .describe("Unique agent name"),
          displayName: z.string().optional(),
          a2aEndpoint: z
            .string()
            .describe(
              "Remote A2A endpoint URL for the custom agent (required)"
            ),
          notifyOn: z
            .enum(["mention", "channel_messages"])
            .describe(
              "When the agent is woken (required): `mention` = only on a name mention; `channel_messages` = every channel message"
            )
        }),
        z.object({
          operation: z.literal("update"),
          name: z.string(),
          displayName: z.string().optional(),
          enabled: z
            .boolean()
            .optional()
            .describe(
              "Set false to disable — disabled agents receive no messages and won't be routed to"
            ),
          a2aEndpoint: z.string().optional(),
          notifyOn: z
            .enum(["mention", "channel_messages"])
            .optional()
            .describe(
              "Change when the agent is woken: mention vs channel_messages"
            )
        }),
        z.object({
          operation: z.literal("add_channel"),
          name: z.string(),
          channelId: z
            .string()
            .describe("A channel id to make this agent routable in")
        }),
        z.object({
          operation: z.literal("remove_channel"),
          name: z.string(),
          channelId: z
            .string()
            .describe("A channel id to stop routing this agent in")
        }),
        z.object({
          operation: z.literal("regenerate_avatar"),
          name: z.string(),
          instructions: z
            .string()
            .optional()
            .describe(
              "Optional art direction for the avatar: style, colors, motifs, mood"
            )
        }),
        z.object({ operation: z.literal("unregister"), name: z.string() })
      ]),
      execute: (args) => agentsWrite(deps, args)
    }),
    workspace_read: tool({
      description:
        "Read workspace(s). Omit `id` to list (org admin) or get your own.",
      inputSchema: z.object({ id: z.coerce.number().int().optional() }),
      execute: (args) => workspaceRead(deps, args)
    }),
    // Self-service identity — the admin changes its OWN Slack presence. Built for
    // every admin instance. `set_avatar` needs the image seams (guarded at
    // runtime); `set_display_name` does not, so this tool is always registered.
    self_write: tool({
      description:
        "Change your own identity (the admin agent's Slack presence). " +
        "set_avatar AI-generates a new avatar from this workspace's name plus any " +
        "art direction; set_display_name renames you. Changes take effect on your " +
        "next reply.",
      inputSchema: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("set_avatar"),
          instructions: z
            .string()
            .optional()
            .describe(
              "Optional art direction for the avatar: style, colors, motifs, mood"
            )
        }),
        z.object({
          operation: z.literal("set_display_name"),
          displayName: z.string().describe("The admin agent's new display name")
        })
      ]),
      execute: (args) => selfWrite(deps, args)
    })
  };

  if (deps.wsId === ORG_WORKSPACE_ID) {
    tools.workspace_write = tool({
      description:
        "Org-admin only: create a workspace, or set a workspace's admin channel.",
      inputSchema: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("create"), name: z.string() }),
        z.object({
          operation: z.literal("set_admin_channel"),
          id: z.coerce.number().int(),
          channelId: z.string()
        })
      ]),
      execute: (args) => workspaceWrite(deps, args)
    });

    tools.remote_agent_domains = tool({
      description:
        "Org-admin only: manage approved domains for remote (custom) A2A agents. " +
        "Each approved domain covers that domain and all its subdomains — " +
        "e.g. approving 'myorg.workers.dev' allows any agent hosted under it. " +
        "Only add domains your organization fully controls: A2A trusts the endpoint " +
        "domain for cryptographic key verification, so any subdomain of an approved " +
        "entry can host a verified agent. Shared platform roots (workers.dev, etc.) " +
        "are permanently blocked regardless. An empty list disables all remote agents.",
      inputSchema: z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("list") }),
        z.object({
          operation: z.literal("add"),
          domain: z
            .string()
            .describe("Domain to approve (covers all its subdomains)")
        }),
        z.object({
          operation: z.literal("remove"),
          domain: z.string().describe("Domain to remove from the approved list")
        })
      ]),
      execute: (args) => remoteAgentDomains(deps, args)
    });
  }

  return tools;
}
