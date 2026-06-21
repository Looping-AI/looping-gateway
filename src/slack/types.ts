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
  text: string;
  raw: Record<string, unknown>;
}

export interface LifecycleWorkflowParams {
  eventId: string;
  type: string;
  subtype?: string;
  channelId?: string;
  userId?: string;
  /** Display name extracted from the Slack envelope at classify time (team_join only). */
  displayName?: string | null;
  raw: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Classification — the routing verdict produced by classifyEvent()
// ---------------------------------------------------------------------------

/**
 * Internal params carried on Message classifications — extends the Workflow
 * params with the team_id so the ingress guard can check it before dispatching.
 */
export interface MessageClassificationParams extends MessageWorkflowParams {
  teamId?: string;
}

/**
 * Internal params carried on Lifecycle classifications — extends the Workflow
 * params with the team_id so the ingress guard can check it before dispatching.
 */
export interface LifecycleClassificationParams extends LifecycleWorkflowParams {
  teamId?: string;
}

export type Classification =
  | { kind: "challenge"; challenge: string }
  | { kind: "message"; params: MessageClassificationParams }
  | { kind: "lifecycle"; params: LifecycleClassificationParams }
  | { kind: "ignore"; reason: string };
