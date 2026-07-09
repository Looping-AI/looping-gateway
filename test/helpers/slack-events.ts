import { handleSlackEvent } from "@/slack-webhook-handler";
import { slackHeaders } from "./slack";

export interface PostCall {
  channel: string;
  text: string;
  thread_ts?: string;
}

export interface ReactionCall {
  method: string;
  channel: string;
  timestamp: string;
  name: string;
}

let _seq = 0;

export function makeAppMentionRequest(channelId: string, text: string) {
  const eventId = `Ev-${++_seq}`;
  const body = JSON.stringify({
    type: "event_callback",
    event_id: eventId,
    team_id: "T1",
    event: {
      type: "app_mention",
      channel: channelId,
      user: "U1",
      text,
      ts: "1700.1",
      event_ts: "1700.1"
    }
  });
  return { body, eventId };
}

export async function trigger(body: string) {
  const waitUntilPromises: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => {
      waitUntilPromises.push(p);
    },
    passThroughOnException: () => {}
  } as unknown as ExecutionContext;
  const res = await handleSlackEvent(
    new Request("https://example.com/slack/events", {
      method: "POST",
      headers: await slackHeaders(body),
      body
    }),
    ctx
  );
  await Promise.allSettled(waitUntilPromises);
  return res;
}
