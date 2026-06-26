-- Backfill any agents that may have been registered without a workspace scope
-- (org-wide custom agents) to workspace 0 (ORG_WORKSPACE_ID). Built-in agents
-- were already seeded with workspace_id = 0, so this is a no-op for them.
-- NOTE: D1 enforces FK constraints and cannot disable them, so the column
-- cannot be tightened to NOT NULL via table-recreation without dropping all
-- agent_channels rows first. The NOT NULL guarantee is enforced at the
-- TypeScript layer (RegisterAgentInput, DispatchAgentRef — all typed `number`).
UPDATE `agents` SET `workspace_id` = 0 WHERE `workspace_id` IS NULL;
