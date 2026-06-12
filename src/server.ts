import { createWorkersAI } from "workers-ai-provider";
import { Agent, routeAgentRequest, type Schedule } from "agents";
import { ChatSdkStateAgent, createChatSdkState } from "agents/chat-sdk";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { Chat, type Message, type Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

// Re-export so the Agents SDK can resolve it as a sub-agent facet via
// ctx.exports["ChatSdkStateAgent"]. The Slack Chat SDK state adapter
// (createChatSdkState) spawns this for thread locks/dedupe/state. It runs as
// a facet of SlackAgent's DO, so it needs no separate binding or migration.
export { ChatSdkStateAgent };

export class SlackAgent extends Agent<Env> {
  private slack!: ReturnType<typeof createSlackAdapter>;
  private chat!: Chat;

  async onStart() {
    this.slack = createSlackAdapter({
      botToken: this.env.SLACK_BOT_TOKEN,
      signingSecret: this.env.SLACK_SIGNING_SECRET,
      mode: "webhook",
    });

    this.chat = new Chat({
      userName: "ai-bot",
      adapters: { slack: this.slack },
      state: createChatSdkState(),
    });

    // To add an MCP server programmatically:
    // await this.addMcpServer("my-server", "https://my-mcp-server.example.com/sse");

    const workersai = createWorkersAI({ binding: this.env.AI });

    const aiHandler = async (thread: Thread, message: Message) => {
      const threadId = thread.id;

      try {
        const { text } = await generateText({
          model: workersai("@cf/moonshotai/kimi-k2.6"),
          system: `You are a helpful assistant. You can check the weather, perform calculations, and schedule tasks.

${getSchedulePrompt({ date: new Date() })}

If the user asks to schedule a task, use the scheduleTask tool.`,
          prompt: message.text,
          tools: {
            // MCP tools from any connected servers
            ...this.mcp.getAITools(),

            getWeather: tool({
              description: "Get the current weather for a city",
              inputSchema: z.object({
                city: z.string().describe("City name"),
              }),
              execute: async ({ city }) => {
                // Replace with a real weather API in production
                const conditions = ["sunny", "cloudy", "rainy", "snowy"];
                const temp = Math.floor(Math.random() * 30) + 5;
                return {
                  city,
                  temperature: temp,
                  condition:
                    conditions[Math.floor(Math.random() * conditions.length)],
                  unit: "celsius",
                };
              },
            }),

            calculate: tool({
              description: "Perform a math calculation with two numbers",
              inputSchema: z.object({
                a: z.number().describe("First number"),
                b: z.number().describe("Second number"),
                operator: z
                  .enum(["+", "-", "*", "/", "%"])
                  .describe("Arithmetic operator"),
              }),
              execute: async ({ a, b, operator }) => {
                const ops: Record<string, (x: number, y: number) => number> = {
                  "+": (x, y) => x + y,
                  "-": (x, y) => x - y,
                  "*": (x, y) => x * y,
                  "/": (x, y) => x / y,
                  "%": (x, y) => x % y,
                };
                if (operator === "/" && b === 0) {
                  return { error: "Division by zero" };
                }
                return {
                  expression: `${a} ${operator} ${b}`,
                  result: ops[operator](a, b),
                };
              },
            }),

            scheduleTask: tool({
              description:
                "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
              inputSchema: scheduleSchema,
              execute: async ({ when, description }) => {
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
                  this.schedule(
                    input,
                    "executeTask",
                    { description, threadId },
                    {
                      idempotent: true,
                    },
                  );
                  return `Task scheduled: "${description}" (${when.type}: ${input})`;
                } catch (error) {
                  return `Error scheduling task: ${error}`;
                }
              },
            }),

            getScheduledTasks: tool({
              description: "List all tasks that have been scheduled",
              inputSchema: z.object({}),
              execute: async () => {
                const tasks = this.getSchedules();
                return tasks.length > 0 ? tasks : "No scheduled tasks found.";
              },
            }),

            cancelScheduledTask: tool({
              description: "Cancel a scheduled task by its ID",
              inputSchema: z.object({
                taskId: z.string().describe("The ID of the task to cancel"),
              }),
              execute: async ({ taskId }) => {
                try {
                  this.cancelSchedule(taskId);
                  return `Task ${taskId} cancelled.`;
                } catch (error) {
                  return `Error cancelling task: ${error}`;
                }
              },
            }),
          },
          stopWhen: stepCountIs(5),
        });
        await thread.post(text);
      } catch (err) {
        const detail =
          err instanceof Error
            ? `${err.name}: ${err.message}\n${err.stack ?? ""}`
            : JSON.stringify(err);
        console.error("Slack AI handler error ->", detail);
        await thread
          .post(`:warning: Sorry, I hit an error: ${detail.slice(0, 500)}`)
          .catch(() => {});
      }
    };

    this.chat.onNewMention(aiHandler);
    this.chat.onDirectMessage(aiHandler);

    await this.chat.initialize();
  }

  async executeTask(
    payload: { description: string; threadId: string },
    _task: Schedule<{ description: string; threadId: string }>,
  ) {
    const { description, threadId } = payload;
    console.log(`Executing scheduled task: ${description}`);
    try {
      await this.slack.postMessage(threadId, `Reminder: ${description}`);
    } catch (err) {
      console.error("Failed to post scheduled task reminder:", err);
    }
  }

  async onRequest(request: Request): Promise<Response> {
    const body = (await request
      .clone()
      .json()
      .catch(() => ({}))) as { type?: string; challenge?: string };
    if (body.type === "url_verification") {
      return Response.json({ challenge: body.challenge });
    }
    return this.slack.handleWebhook(request);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/slack/events") {
      const id = env.SlackAgent.idFromName("default");
      const stub = env.SlackAgent.get(id);
      return stub.fetch(request);
    }

    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
