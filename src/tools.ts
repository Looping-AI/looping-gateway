import { type z } from "zod";
import { scheduleSchema } from "agents/schedule";

export type ScheduleTaskInput = z.infer<typeof scheduleSchema>;

export interface ScheduleAgent {
  schedule(
    input: string | number,
    method: string,
    payload: unknown,
    options?: { idempotent?: boolean }
  ): void;
  getSchedules(): unknown[];
  cancelSchedule(taskId: string): void;
}

export function getWeather({ city }: { city: string }) {
  const conditions = ["sunny", "cloudy", "rainy", "snowy"] as const;
  const temp = Math.floor(Math.random() * 30) + 5;
  return {
    city,
    temperature: temp,
    condition: conditions[Math.floor(Math.random() * conditions.length)],
    unit: "celsius" as const
  };
}

export function calculate({
  a,
  b,
  operator
}: {
  a: number;
  b: number;
  operator: "+" | "-" | "*" | "/" | "%";
}) {
  if (operator === "/" && b === 0) {
    return { error: "Division by zero" };
  }
  const ops: Record<string, (x: number, y: number) => number> = {
    "+": (x, y) => x + y,
    "-": (x, y) => x - y,
    "*": (x, y) => x * y,
    "/": (x, y) => x / y,
    "%": (x, y) => x % y
  };
  return {
    expression: `${a} ${operator} ${b}`,
    result: ops[operator](a, b)
  };
}

export function scheduleTask(
  { when, description }: ScheduleTaskInput,
  threadId: string,
  agent: ScheduleAgent
): string {
  if (when.type === "no-schedule") {
    return "Not a valid schedule input";
  }
  const input =
    when.type === "scheduled"
      ? when.date
      : when.type === "delayed"
        ? when.delayInSeconds
        : when.type === "cron"
          ? when.cron
          : null;
  if (!input) return "Invalid schedule type";
  try {
    agent.schedule(
      input,
      "executeTask",
      { description, threadId },
      { idempotent: true }
    );
    return `Task scheduled: "${description}" (${when.type}: ${input})`;
  } catch (error) {
    return `Error scheduling task: ${error}`;
  }
}

export function getScheduledTasks(agent: ScheduleAgent): unknown[] | string {
  const tasks = agent.getSchedules();
  return tasks.length > 0 ? tasks : "No scheduled tasks found.";
}

export function cancelScheduledTask(
  { taskId }: { taskId: string },
  agent: ScheduleAgent
): string {
  try {
    agent.cancelSchedule(taskId);
    return `Task ${taskId} cancelled.`;
  } catch (error) {
    return `Error cancelling task: ${error}`;
  }
}
