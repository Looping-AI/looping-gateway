import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { sweepStaleAgentTasks } from "@/db/models/agent-tasks";

type MaintenanceWorkflowPayload = Record<string, never>;

export class MaintenanceWorkflow extends WorkflowEntrypoint<
  Env,
  MaintenanceWorkflowPayload
> {
  async run(
    event: WorkflowEvent<MaintenanceWorkflowPayload>,
    step: WorkflowStep
  ) {
    try {
      // Drop stale remote-agent task rows. The reaction backstop already clears
      // the 🛑 for tasks that never called back, so these rows are pure
      // correlation records — sweep old ones so the table stays bounded.
      await step.do("sweep-agent-tasks", () => sweepStaleAgentTasks());
    } catch (err) {
      console.error("[maintenance] workflow run failed", {
        instanceId: event.instanceId,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined
      });
      throw err;
    }
  }
}
