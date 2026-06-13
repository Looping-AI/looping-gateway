import { describe, it, expect, vi } from "vitest";
import {
  getWeather,
  calculate,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask,
  type ScheduleAgent
} from "../src/tools";

describe("getWeather", () => {
  it("returns weather data for a city", () => {
    const result = getWeather({ city: "Lisbon" });
    expect(result.city).toBe("Lisbon");
    expect(result.unit).toBe("celsius");
    expect(result.temperature).toBeGreaterThanOrEqual(5);
    expect(result.temperature).toBeLessThanOrEqual(34);
    expect(["sunny", "cloudy", "rainy", "snowy"]).toContain(result.condition);
  });
});

describe("calculate", () => {
  it("adds two numbers", () => {
    expect(calculate({ a: 3, b: 4, operator: "+" })).toEqual({
      expression: "3 + 4",
      result: 7
    });
  });

  it("subtracts two numbers", () => {
    expect(calculate({ a: 10, b: 3, operator: "-" })).toEqual({
      expression: "10 - 3",
      result: 7
    });
  });

  it("multiplies two numbers", () => {
    expect(calculate({ a: 6, b: 7, operator: "*" })).toEqual({
      expression: "6 * 7",
      result: 42
    });
  });

  it("divides two numbers", () => {
    expect(calculate({ a: 10, b: 2, operator: "/" })).toEqual({
      expression: "10 / 2",
      result: 5
    });
  });

  it("returns modulo of two numbers", () => {
    expect(calculate({ a: 10, b: 3, operator: "%" })).toEqual({
      expression: "10 % 3",
      result: 1
    });
  });

  it("returns error on division by zero", () => {
    expect(calculate({ a: 5, b: 0, operator: "/" })).toEqual({
      error: "Division by zero"
    });
  });
});

function makeAgent(overrides: Partial<ScheduleAgent> = {}): ScheduleAgent {
  return {
    schedule: vi.fn(),
    getSchedules: vi.fn().mockReturnValue([]),
    cancelSchedule: vi.fn(),
    ...overrides
  };
}

describe("scheduleTask", () => {
  it("rejects no-schedule type", () => {
    const agent = makeAgent();
    const result = scheduleTask(
      { when: { type: "no-schedule" }, description: "test" },
      "thread-1",
      agent
    );
    expect(result).toBe("Not a valid schedule input");
    expect(agent.schedule).not.toHaveBeenCalled();
  });

  it("schedules a delayed task", () => {
    const agent = makeAgent();
    const result = scheduleTask(
      { when: { type: "delayed", delayInSeconds: 60 }, description: "ping" },
      "thread-1",
      agent
    );
    expect(result).toBe('Task scheduled: "ping" (delayed: 60)');
    expect(agent.schedule).toHaveBeenCalledWith(
      60,
      "executeTask",
      { description: "ping", threadId: "thread-1" },
      { idempotent: true }
    );
  });

  it("schedules a task at a specific date", () => {
    const agent = makeAgent();
    const result = scheduleTask(
      {
        when: { type: "scheduled", date: "2026-07-01T10:00:00Z" },
        description: "stand-up"
      },
      "thread-2",
      agent
    );
    expect(result).toBe(
      'Task scheduled: "stand-up" (scheduled: 2026-07-01T10:00:00Z)'
    );
    expect(agent.schedule).toHaveBeenCalledWith(
      "2026-07-01T10:00:00Z",
      "executeTask",
      { description: "stand-up", threadId: "thread-2" },
      { idempotent: true }
    );
  });

  it("schedules a recurring cron task", () => {
    const agent = makeAgent();
    const result = scheduleTask(
      { when: { type: "cron", cron: "0 9 * * 1" }, description: "weekly" },
      "thread-3",
      agent
    );
    expect(result).toBe('Task scheduled: "weekly" (cron: 0 9 * * 1)');
  });

  it("returns error string when schedule throws", () => {
    const agent = makeAgent({
      schedule: vi.fn().mockImplementation(() => {
        throw new Error("schedule failed");
      })
    });
    const result = scheduleTask(
      { when: { type: "delayed", delayInSeconds: 30 }, description: "fail" },
      "t",
      agent
    );
    expect(result).toMatch(/Error scheduling task/);
  });
});

describe("getScheduledTasks", () => {
  it("returns tasks when any exist", () => {
    const tasks = [{ id: "1", description: "task one" }];
    const agent = makeAgent({ getSchedules: vi.fn().mockReturnValue(tasks) });
    expect(getScheduledTasks(agent)).toEqual(tasks);
  });

  it("returns a string when no tasks exist", () => {
    const agent = makeAgent();
    expect(getScheduledTasks(agent)).toBe("No scheduled tasks found.");
  });
});

describe("cancelScheduledTask", () => {
  it("cancels a task by id", () => {
    const agent = makeAgent();
    const result = cancelScheduledTask({ taskId: "abc-123" }, agent);
    expect(result).toBe("Task abc-123 cancelled.");
    expect(agent.cancelSchedule).toHaveBeenCalledWith("abc-123");
  });

  it("returns error string when cancelSchedule throws", () => {
    const agent = makeAgent({
      cancelSchedule: vi.fn().mockImplementation(() => {
        throw new Error("no such task");
      })
    });
    const result = cancelScheduledTask({ taskId: "bad-id" }, agent);
    expect(result).toMatch(/Error cancelling task/);
  });
});
