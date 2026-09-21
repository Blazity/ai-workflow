/**
 * The worker half of the demo integration. It talks to no real provider: it
 * answers from ctx.connection and its own inputs, recording everything it
 * would have sent into a module-level in-memory log. That is what makes it
 * usable as a deterministic demo and test fixture. May import
 * @integrations/sdk and ./manifest only; no "use step" directive belongs
 * here, core runs every block in its own generic integration step.
 */
import {
  defineIntegrationRuntime,
  type IntegrationContext,
  type IntegrationRuntimeDefinition,
  type MessagingAdapter,
  type TicketEvent,
} from "@integrations/sdk";
import { manifest } from "./manifest";

type DemoManifest = typeof manifest;

interface RecordedMessage {
  readonly ticketKey: string;
  readonly event: TicketEvent;
  readonly channel: string;
  readonly at: string;
}

// Per-process log of everything the demo messaging adapter has "sent". A demo
// or a test reads this to assert on what happened; nothing else depends on it.
const sentMessages: RecordedMessage[] = [];

function demoMessaging(ctx: IntegrationContext<DemoManifest>): MessagingAdapter {
  return {
    async notifyForTicket(ticket, event, conversation) {
      // The port promises never to throw, and answers whether it delivered.
      sentMessages.push({
        ticketKey: ticket.key,
        event,
        channel: ctx.connection.channel,
        at: new Date().toISOString(),
      });
      // One thread per ticket, the same way a real provider anchors one.
      if (conversation.handle === null) await conversation.remember(ticket.key);
      return { delivered: true };
    },
  };
}

const definition: IntegrationRuntimeDefinition<DemoManifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(new URL("/me", ctx.connection.baseUrl), {
      headers: { authorization: `Bearer ${ctx.connection.apiToken}` },
      signal: ctx.signal,
      timeoutMs: 5_000,
    });
    if (response.ok) return { ok: true };
    return { ok: false, reason: await response.text() };
  },
  capabilities: {
    messaging: demoMessaging,
  },
  blocks: {
    demo_echo: async ({ params, inputs }, ctx) => {
      const reply = inputs.ticketKey ? `${params.message} (${inputs.ticketKey})` : params.message;
      ctx.log.info({ reply }, "demo_echo_replied");
      return { kind: "next", output: { status: "ok", reply } };
    },
    demo_lookup: async ({ params }, ctx) => {
      const matches = Math.min(params.limit, params.query.length);
      if (matches === 0) {
        return { kind: "next", output: { status: "nothing_found", summary: "No matches.", matches: 0 } };
      }
      const summary = `Found ${matches} match${matches === 1 ? "" : "es"} for "${params.query}".`;
      await ctx.capabilities.messaging.notifyForTicket(params.query, { kind: "note", text: summary });
      return { kind: "next", output: { status: "found", summary, matches } };
    },
  },
  health: {
    auth: async (ctx) => {
      const response = await ctx.http.fetch(new URL("/me", ctx.connection.baseUrl), { signal: ctx.signal, retries: 0 });
      if (response.ok) return { status: "live" };
      return { status: response.status === 401 ? "down" : "degraded", message: `The demo provider answered ${response.status}.` };
    },
    delivery: async () => {
      if (sentMessages.length === 0) return { status: "degraded", message: "No message has been sent yet." };
      return { status: "live" };
    },
  },
};

export const runtime = defineIntegrationRuntime(manifest, definition);
