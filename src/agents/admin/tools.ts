import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { authorize, type UserAuthContext } from "@/auth";
import type { CardSigningPin } from "@/a2a/card-verify";
import type { Db } from "@/db/client";
import {
  type AgentRow,
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
  setAllowedRemoteAgentDomains
} from "@/db/models/workspace-configs";
import { SHARED_INFRA_ROOTS } from "@/a2a/endpoint";

/**
 * Admin tools — registry + workspace CRUD on D1. Consolidated to read/write per
 * domain (no tool proliferation): `agents_read`, `agents_write`,
 * `workspace_read`, `workspace_write`, `remote_agent_domains`. Writes use a
 * discriminated `operation`.
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
  db: Db;
  ctx: UserAuthContext | null;
  /** The workspace this admin instance manages (admin:{wsId}). */
  wsId: number;
  /**
   * Validates a custom agent's endpoint (SSRF policy) and verifies its signed
   * AgentCard, returning the signing identity to pin. Injected so the pure
   * handlers stay offline-testable; production binds it to the live verifier.
   */
  verifyEndpoint: EndpointVerifier;
}

/** Verify a remote agent endpoint + signed card; resolves to the pin to persist. */
export type EndpointVerifier = (endpoint: string) => Promise<CardSigningPin>;

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
    enabled: a.enabled,
    a2aEndpoint: a.a2aEndpoint,
    workspaceId: a.workspaceId,
    channels
  };
}

/** Shape an agent row for the model (small, with its channel attachments). */
async function present(db: Db, a: AgentRow): Promise<ToolResult> {
  return shape(a, await getAgentChannels(db, a.name));
}

/** Resolve a write target: must exist, belong to this workspace, and be a custom agent. */
async function requireWritableAgent(
  deps: AdminToolDeps,
  name: string
): Promise<AgentRow | { error: string }> {
  if (RESERVED_NAMES.has(name)) {
    return { error: `"${name}" is a built-in agent and cannot be modified.` };
  }
  const a = await getAgent(deps.db, name);
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
    const a = await getAgent(deps.db, args.name);
    return {
      agents:
        a && a.workspaceId === deps.wsId ? [await present(deps.db, a)] : []
    };
  }
  const rows = await listAgentsForWorkspace(deps.db, deps.wsId);
  const channelRows = await listChannelsForAgents(
    deps.db,
    rows.map((r) => r.name)
  );
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
    }
  | {
      operation: "update";
      name: string;
      displayName?: string;
      enabled?: boolean;
      a2aEndpoint?: string;
    }
  | { operation: "add_channel"; name: string; channelId: string }
  | { operation: "remove_channel"; name: string; channelId: string }
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
      if (await getAgent(deps.db, args.name))
        return { error: `An agent named "${args.name}" already exists.` };
      let pin: CardSigningPin;
      try {
        pin = await deps.verifyEndpoint(args.a2aEndpoint);
      } catch (err) {
        return {
          error: `Endpoint verification failed: ${(err as Error).message}`
        };
      }
      const row = await registerAgent(deps.db, {
        name: args.name,
        kind: "custom",
        displayName: args.displayName ?? null,
        a2aEndpoint: args.a2aEndpoint,
        workspaceId: deps.wsId,
        cardSigningJku: pin.cardSigningJku,
        cardSigningKid: pin.cardSigningKid
      });
      return { ok: true, agent: await present(deps.db, row) };
    }
    case "update": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      // A re-pointed endpoint is re-verified and must keep the SAME pinned
      // signing identity (Trust-On-First-Use) — a different signer is rejected.
      let pin: CardSigningPin | undefined;
      if (
        args.a2aEndpoint !== undefined &&
        args.a2aEndpoint !== target.a2aEndpoint
      ) {
        try {
          pin = await deps.verifyEndpoint(args.a2aEndpoint);
        } catch (err) {
          return {
            error: `Endpoint verification failed: ${(err as Error).message}`
          };
        }
        if (
          target.cardSigningKid &&
          (pin.cardSigningKid !== target.cardSigningKid ||
            pin.cardSigningJku !== target.cardSigningJku)
        ) {
          return {
            error:
              `New endpoint for "${args.name}" is signed by a different key than the ` +
              `one pinned at registration. Unregister and re-register if the agent's ` +
              `signing identity changed intentionally.`
          };
        }
      }
      await updateAgent(deps.db, args.name, {
        displayName: args.displayName,
        enabled: args.enabled,
        a2aEndpoint: args.a2aEndpoint,
        ...(pin
          ? {
              cardSigningJku: pin.cardSigningJku,
              cardSigningKid: pin.cardSigningKid
            }
          : {})
      });
      const updated = await getAgent(deps.db, args.name);
      return {
        ok: true,
        agent: updated ? await present(deps.db, updated) : null
      };
    }
    case "add_channel": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await attachAgentChannel(deps.db, {
        agentName: args.name,
        channelId: args.channelId,
        workspaceId: deps.wsId
      });
      return { ok: true, agent: await present(deps.db, target) };
    }
    case "remove_channel": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await detachAgentChannel(deps.db, args.name, args.channelId);
      return { ok: true, agent: await present(deps.db, target) };
    }
    case "unregister": {
      const target = await requireWritableAgent(deps, args.name);
      if ("error" in target) return target;
      await unregisterAgent(deps.db, args.name);
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
    const ws = await getWorkspace(deps.db, args.id);
    return { workspaces: ws ? [ws] : [] };
  }
  if (isOrg) return { workspaces: await listWorkspaces(deps.db) };
  const ws = await getWorkspace(deps.db, deps.wsId);
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
      const ws = await createWorkspace(deps.db, { name: args.name });
      return { ok: true, workspace: ws };
    }
    case "set_admin_channel": {
      if (!(await getWorkspace(deps.db, args.id)))
        return { error: `Workspace ${args.id} not found.` };
      await setWorkspaceAdminChannel(deps.db, args.id, args.channelId);
      return { ok: true, workspace: await getWorkspace(deps.db, args.id) };
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

  const current = await getAllowedRemoteAgentDomains(deps.db);

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
    await setAllowedRemoteAgentDomains(deps.db, updated);
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
  await setAllowedRemoteAgentDomains(deps.db, updated);
  return { ok: true, approvedDomains: updated };
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
        "manage one channel at a time. " +
        "Built-in admin/onboarding agents cannot be modified.",
      inputSchema: z.discriminatedUnion("operation", [
        z.object({
          operation: z.literal("register"),
          name: z.string().describe("Unique agent name"),
          displayName: z.string().optional(),
          a2aEndpoint: z
            .string()
            .describe("Remote A2A endpoint URL for the custom agent (required)")
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
          a2aEndpoint: z.string().optional()
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
        z.object({ operation: z.literal("unregister"), name: z.string() })
      ]),
      execute: (args) => agentsWrite(deps, args)
    }),
    workspace_read: tool({
      description:
        "Read workspace(s). Omit `id` to list (org admin) or get your own.",
      inputSchema: z.object({ id: z.coerce.number().int().optional() }),
      execute: (args) => workspaceRead(deps, args)
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
