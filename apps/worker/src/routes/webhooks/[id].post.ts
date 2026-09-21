import { createError, defineEventHandler, getQuery, getRequestHeaders, readRawBody } from "h3";
import { waitUntil } from "@vercel/functions";

/**
 * Every integration's webhook, at the URL its provider already calls.
 *
 * `/webhooks/slack` and whatever the next integration registers land here;
 * core's own routes (`/webhooks/github`, `/webhooks/gitlab`, `/webhooks/jira`,
 * `/webhooks/custom/...`, `/webhooks/resend`) keep their own files and win,
 * because a static route beats a dynamic one.
 *
 * What this route does and does not do is the whole of ADR-010's webhook
 * decision. It holds the raw bytes, because that is what a provider signs and
 * a body parsed on the way in cannot be verified. It hands them to the
 * integration, which decides whether the request is genuine and what it means.
 * When the answer is a run control command, core runs it: which runs are live
 * and what cancel does are the product's, not a chat provider's. Then the
 * integration renders and delivers the answer its own way.
 *
 * A provider is answered inside its own deadline (Slack allows about three
 * seconds), so the command runs after the response, through `waitUntil`, and
 * whatever it produced, including a failure, is delivered. A person who reads
 * "Working on ..." gets an answer either way.
 */

/** Bounds the whole invocation, deferred delivery included. */
const WEBHOOK_TIMEOUT_MS = 120_000;

export default defineEventHandler(async (event) => {
  const id = event.context.params?.id ?? "";
  const rawBody = (await readRawBody(event, "utf8")) ?? "";

  const { integrationManifest } = await import("@integrations/registry");
  const { integrationRuntime } = await import("@integrations/registry/worker");
  const manifest = integrationManifest(id);
  const runtime = manifest ? integrationRuntime(id) : null;
  const webhook = runtime?.webhook;
  if (!manifest || !webhook) {
    throw createError({ statusCode: 404, statusMessage: "No such webhook" });
  }

  const { resolveUsableIntegrations } = await import("../../services/integrations/runtime.js");
  const signal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  const resolved = await resolveUsableIntegrations({
    signal,
    filter: (candidate) => candidate.id === id,
  });
  if (!resolved.readable) {
    // Not a refusal of the request: this deployment could not read its own
    // settings, so it cannot tell an allowed sender from anyone else. Saying
    // so is the difference between failing closed and failing silently.
    throw createError({
      statusCode: 503,
      statusMessage: `${manifest.name} could not be read on this deployment, so the request was not acted on.`,
    });
  }
  const usable = resolved.usable.find((candidate) => candidate.manifest.id === id);
  if (!usable) {
    const state = resolved.states.get(id);
    throw createError({
      statusCode: 503,
      statusMessage:
        state?.enabled === false
          ? `${manifest.name} is disabled on this deployment.`
          : `${manifest.name} is not connected on this deployment.`,
    });
  }

  const reception = await webhook.receive(
    {
      method: event.method,
      rawBody,
      headers: lowercased(getRequestHeaders(event)),
      query: stringValues(getQuery(event)),
    } as never,
    usable.ctx as never,
  );

  if (reception.kind === "refused") {
    throw createError({ statusCode: reception.status, statusMessage: reception.reason });
  }
  if (reception.kind === "answered") {
    return respond(event, reception.response);
  }

  const { logger } = await import("../../services/system/logger.js");
  if (!webhook.deliver) {
    // The command still runs: it is what the person asked for. That the answer
    // cannot come back is a defect of the integration, and it is said here
    // rather than swallowed.
    logger.warn({ integration: id }, "integration_webhook_reply_undeliverable");
  }
  waitUntil(
    runAndDeliver(id, reception, usable, webhook.deliver).catch((error: unknown) =>
      logger.error(
        { integration: id, error: error instanceof Error ? error.message : String(error) },
        "integration_webhook_delivery_failed",
      ),
    ),
  );
  return respond(event, reception.response);
});

/**
 * Run the command and hand whatever came of it back.
 *
 * A failure is delivered rather than logged and dropped: the person is
 * watching an acknowledgement that promised an answer, and silence is the one
 * outcome they cannot act on.
 */
async function runAndDeliver(
  id: string,
  reception: { command: unknown; deliverTo: unknown },
  usable: { ctx: unknown },
  deliver: ((delivery: never, ctx: never) => Promise<void>) | undefined,
): Promise<void> {
  const { executeRunControlCommand, runControlDeps } = await import(
    "../../services/run-control/index.js"
  );
  const { logger } = await import("../../services/system/logger.js");
  let outcome: { kind: "answered"; answer: unknown } | { kind: "failed"; message: string };
  try {
    const answer = await executeRunControlCommand(
      reception.command as never,
      await runControlDeps(),
    );
    outcome = { kind: "answered", answer };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ integration: id, error: message }, "run_control_command_failed");
    outcome = { kind: "failed", message };
  }
  if (!deliver) return;
  await deliver({ to: reception.deliverTo, outcome } as never, usable.ctx as never);
}

function respond(
  event: Parameters<typeof getQuery>[0],
  response: { status: number; body?: unknown },
): unknown {
  event.node.res.statusCode = response.status;
  return response.body ?? "";
}

function lowercased(headers: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name.toLowerCase()] = value;
  }
  return out;
}

function stringValues(query: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}
