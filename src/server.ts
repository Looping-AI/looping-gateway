import { createWorkersAI } from "workers-ai-provider";
import { Agent, routeAgentRequest, type Schedule } from "agents";
import { ChatSdkStateAgent, createChatSdkState } from "agents/chat-sdk";
import { getSchedulePrompt, scheduleSchema } from "agents/schedule";
import { Chat, type Message, type Thread } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import {
  getWeather,
  calculate,
  scheduleTask,
  getScheduledTasks,
  cancelScheduledTask
} from "./tools";
import { handleSlackEvent } from "./slack-webhook-handler";
import { reconcile } from "@/services/reconcile";

// Cloudflare resolves Workflow `class_name`s (wrangler.jsonc) from the entry
// module's exports, just like Durable Objects.
export { MessageWorkflow } from "./workflows/message";
export { LifecycleWorkflow } from "./workflows/lifecycle";

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
      mode: "webhook"
    });

    this.chat = new Chat({
      userName: "ai-bot",
      adapters: { slack: this.slack },
      state: createChatSdkState()
    });

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
            ...this.mcp.getAITools(),

            getWeather: tool({
              description: "Get the current weather for a city",
              inputSchema: z.object({
                city: z.string().describe("City name")
              }),
              execute: async (input) => getWeather(input)
            }),

            calculate: tool({
              description: "Perform a math calculation with two numbers",
              inputSchema: z.object({
                a: z.number().describe("First number"),
                b: z.number().describe("Second number"),
                operator: z
                  .enum(["+", "-", "*", "/", "%"])
                  .describe("Arithmetic operator")
              }),
              execute: async (input) => calculate(input)
            }),

            scheduleTask: tool({
              description:
                "Schedule a task to be executed at a later time. Use this when the user asks to be reminded or wants something done later.",
              inputSchema: scheduleSchema,
              execute: async (input) => scheduleTask(input, threadId, this)
            }),

            getScheduledTasks: tool({
              description: "List all tasks that have been scheduled",
              inputSchema: z.object({}),
              execute: async () => getScheduledTasks(this)
            }),

            cancelScheduledTask: tool({
              description: "Cancel a scheduled task by its ID",
              inputSchema: z.object({
                taskId: z.string().describe("The ID of the task to cancel")
              }),
              execute: async (input) => cancelScheduledTask(input, this)
            })
          },
          stopWhen: stepCountIs(5)
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
    _task: Schedule<{ description: string; threadId: string }>
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
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    // Slack webhook ingest — verify signature, classify event, trigger the
    // matching durable Workflow, and ack within Slack's 3s budget. All agent
    // work happens asynchronously inside the Workflow, never inline here.
    if (request.method === "POST" && url.pathname === "/slack/events") {
      return handleSlackEvent(request, env);
    }

    // Agents SDK routing — handles WebSocket upgrades and RPC calls to in-repo
    // agent DOs at /agents/{ClassName}/{instanceName}. Required now for
    // SlackAgent and load-bearing for Phase 4-5 when Admin and Onboarding
    // agents come online as A2A servers.
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },

  // Cron reconciliation (wrangler triggers.crons): the convergence backstop
  // that repairs registry drift against Slack reality. Errors are logged, not
  // rethrown — a failed run just retries on the next tick.
  async scheduled(_controller: ScheduledController, env: Env) {
    try {
      const result = await reconcile(env);
      console.log("Reconciliation complete", result);
    } catch (err) {
      console.error("Reconciliation failed", err);
    }
  }
} satisfies ExportedHandler<Env>;
