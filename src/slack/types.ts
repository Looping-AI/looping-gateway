// ---------------------------------------------------------------------------
// Params passed into Workflows — must be Rpc.Serializable (plain JSON types).
// ---------------------------------------------------------------------------

export interface MessageWorkflowParams {
  eventId: string;
  eventType: "app_mention" | "message";
  channelId: string;
  threadTs: string;
  ts: string;
  /** Always set — the classifier ignores message events without a sender. */
  userId: string;
  teamId?: string;
  text: string;
  raw: Record<string, unknown>;
}

export interface LifecycleWorkflowParams {
  eventId: string;
  type: string;
  subtype?: string;
  channelId?: string;
  userId?: string;
  teamId?: string;
  /** Display name extracted from the Slack envelope at classify time (team_join only). */
  displayName?: string | null;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Classification — the routing verdict produced by classifyEvent()
// ---------------------------------------------------------------------------

export type Classification =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; params: MessageWorkflowParams }
  | { kind: "lifecycle"; params: LifecycleWorkflowParams }
  | { kind: "ignore"; reason: string };
