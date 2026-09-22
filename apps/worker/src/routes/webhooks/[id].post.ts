import { createError, defineEventHandler, getQuery, getRequestHeaders, readRawBody } from "h3";
import { waitUntil } from "@vercel/functions";

/**
 * Every integration's webhook, at the URL its provider already calls.
 *
 * `/webhooks/slack`, `/webhooks/github` and every other integration callback
 * land here; core's own routes (`/webhooks/jira`, `/webhooks/custom/...`,
 * `/webhooks/resend`) keep their own files and win, because a static route
 * beats a dynamic one. Each provider keeps the URL it already calls whichever
 * side of that line it is on.
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
    observeWebhook(id, "rejected", "integration_configuration_unreadable");
    throw createError({
      statusCode: 503,
      statusMessage: `${manifest.name} could not be read on this deployment, so the request was not acted on.`,
    });
  }
  const state = resolved.states.get(id);
  if (state?.enabled === false) {
    // A disabled integration deliberately does not verify or dispatch the
    // request because its connection is inactive. It still answers 2xx so the
    // provider does not retry or switch off the webhook, and records exactly
    // why the otherwise valid delivery was ignored.
    observeWebhook(id, "accepted", "integration_disabled_ignored");
    return respond(event, { status: 202 });
  }
  const usable = resolved.usable.find((candidate) => candidate.manifest.id === id);
  if (!usable) {
    observeWebhook(id, "rejected", "integration_disconnected");
    throw createError({
      statusCode: 503,
      statusMessage: `${manifest.name} is not connected on this deployment.`,
    });
  }

  const botLoginFor = memoizedVcsBotLogin();
  const { legacyBotLogin: _legacyBotLogin, ...connectionWithoutLegacyBot } =
    usable.ctx.connection;
  const webhookContext = {
    ...usable.ctx,
    connection: {
      ...connectionWithoutLegacyBot,
      // Resolving it reads this deployment's integration settings a second
      // time, and only a version control provider has an automation account to
      // resolve: for anything else the answer is `undefined` whatever the read
      // returns. Slack allows about three seconds, so it does not pay for it.
      botLogin: manifest.capabilities.includes("vcs")
        ? await botLoginFor(id)
        : undefined,
    },
  };
  const reception = await webhook.receive(
    {
      method: event.method,
      rawBody,
      headers: lowercased(getRequestHeaders(event)),
      query: stringValues(getQuery(event)),
    } as never,
    webhookContext as never,
  );

  if (reception.kind === "refused") {
    observeWebhook(id, "rejected", `request_refused_${reception.status}`);
    throw createError({ statusCode: reception.status, statusMessage: reception.reason });
  }
  observeWebhook(id, "accepted", "request_accepted");
  if (reception.kind === "answered") {
    return respond(event, reception.response);
  }
  if (reception.kind === "ticket_events") {
    // The integration read its provider's bytes and said what happened to a
    // ticket. What that means for a run is core's, and it is the same for the
    // next issue tracker: see `services/triggers/ticket-events.ts`.
    if (reception.events.length === 0) {
      const ignored = reception.ignored;
      return respond(event, {
        ...reception.response,
        body: {
          status: "ignored",
          reason: ignored?.reason ?? "nothing_to_act_on",
          ...(ignored?.ticketKey ? { ticketKey: ignored.ticketKey } : {}),
        },
      });
    }
    const { getRequestSettingsSnapshot } = await import("../../services/settings/index.js");
    const { actOnTicketEvent } = await import("../../services/triggers/ticket-events.js");
    const { TriggerHttpError } = await import(
      "../../services/triggers/trigger-http-error.js"
    );
    // Memoised on the request, so the board read and the dispatch read below
    // are one query however many phases ask for the snapshot.
    const loadSettings = () => getRequestSettingsSnapshot(event);
    let outcome;
    try {
      // One delivery, one ticket, for every tracker this contract has met. The
      // loop is here so a tracker that batches is not a rewrite of this route,
      // and the LAST outcome is what the delivery log shows, because a batch
      // that dispatched and then refused has to read as refused.
      for (const candidate of reception.events) {
        outcome = await actOnTicketEvent(candidate, loadSettings);
      }
    } catch (error) {
      // The signature checked out and this deployment could not finish acting
      // on it. That is a rejected delivery, not an accepted one: the health
      // screen reads the last word on a webhook, and calling this accepted
      // would paint it Live while every delivery was failing.
      observeWebhook(id, "rejected", "handler_failed");
      if (error instanceof TriggerHttpError) {
        throw createError({
          statusCode: error.statusCode,
          statusMessage: error.statusMessage,
          ...(error.data ? { data: error.data } : {}),
        });
      }
      throw error;
    }
    return respond(event, { ...reception.response, ...(outcome ? { body: outcome } : {}) });
  }

  if (reception.kind === "trigger_events") {
    const { getRequestSettingsSnapshot } = await import(
      "../../services/settings/index.js"
    );
    const { getRequestRepositoryCatalogSnapshot } = await import(
      "../../services/repository-catalog/index.js"
    );
    const {
      createConnectedTriggerRunRegistry,
      dispatchPostPrGateWebhook,
      dispatchTriggerEvent,
      isRepositoryDispatchable,
    } = await import("../../services/dispatch/index.js");
    const { maxConcurrentAgents } = await import("../../services/settings/index.js");
    const [settings, repositoryCatalog] = await Promise.all([
      getRequestSettingsSnapshot(event),
      getRequestRepositoryCatalogSnapshot(event),
    ]);
    let claimed = false;
    let suppressedWorkflowPush = false;
    let retryable: { reason: string; diagnosticId?: string } | undefined;
    // What core did with the delivery, for the answer the provider records in
    // its own delivery log. The integration's `response` was decided before
    // dispatch and can only say whether there was anything to dispatch, so an
    // event for a repository nobody enabled would be logged as accepted at the
    // provider and leave an operator with nowhere to see that nothing ran.
    let dispatched: { runId?: string } | undefined;
    let ignoredReason: string | undefined;
    let gateDispatched = false;
    for (const candidate of reception.events) {
      if (candidate.triggerType === "trigger_pr_updated") {
        const {
          connectedWorkflowPushNormalizationOptions,
          isWorkflowGeneratedPush,
        } = await import("../../services/publication/index.js");
        const workflowPush = await connectedWorkflowPushNormalizationOptions({
          provider: candidate.pr.provider,
          repoPath: candidate.pr.repoPath,
          prNumber: candidate.pr.prNumber,
        });
        if (isWorkflowGeneratedPush({
          currentHeadSha: candidate.pr.headSha,
          producer: candidate.delivery.producer,
          botIdentity: await botLoginFor(candidate.pr.provider),
          ...workflowPush,
        })) {
          suppressedWorkflowPush = true;
          continue;
        }
      }
      const result = await dispatchTriggerEvent(candidate, {
        runRegistry: createConnectedTriggerRunRegistry(),
        maxConcurrentAgents: maxConcurrentAgents(settings),
        repositoryCatalog,
      });
      // AT CAPACITY IS NOT A FAILED DELIVERY. Nothing is wrong with what the
      // provider sent: this deployment is busy, which can last minutes. GitLab
      // switches a webhook off after a few consecutive failures, and a
      // disabled webhook loses EVERY later trigger rather than this one, so a
      // 5xx here trades one missed event for all of them. The answer is 2xx
      // and says exactly what happened, which both providers record in their
      // delivery log beside the event.
      if (result.result === "at_capacity") {
        ignoredReason = "at_capacity";
        break;
      }
      // An error is a fault of this deployment, and rare. It answers 5xx so it
      // is red in the provider's log and can be redelivered by hand.
      if (result.result === "error") {
        retryable = {
          reason: "trigger_error",
          ...(result.diagnosticId ? { diagnosticId: result.diagnosticId } : {}),
        };
        break;
      }
      if (![
        "no_definition",
        "ignored_not_workflow_owned",
        "ignored_provider",
        "ignored_repository_not_enabled",
      ].includes(result.result)) {
        claimed = true;
        const runId = "runId" in result ? result.runId : undefined;
        dispatched = runId ? { runId } : {};
        break;
      }
      // The last reason, because the loop stops at the first event that
      // claimed: what is left when none did is why the last one did not.
      ignoredReason = result.result;
    }
    if (
      !suppressedWorkflowPush &&
      reception.legacyGate?.headMoved === true
    ) {
      const {
        connectedWorkflowPushNormalizationOptions,
        isWorkflowGeneratedPush,
      } = await import("../../services/publication/index.js");
      const input = reception.legacyGate.workflowInput;
      const workflowPush = await connectedWorkflowPushNormalizationOptions({
        provider: input.provider,
        repoPath: input.ownerRepo,
        prNumber: input.prNumber,
      });
      // Who PUSHED, never the pull request's author: on a pull request this
      // product opened the author is our own account, so asking the author
      // would suppress every human push and skip the gate on it. An
      // integration that did not say who pushed suppresses nothing, which
      // runs the gate: checking a change twice costs a run, skipping the check
      // on somebody's change costs the review it exists for.
      const pusher = reception.legacyGate.pusher;
      suppressedWorkflowPush = pusher
        ? isWorkflowGeneratedPush({
            currentHeadSha: input.headSha,
            producer: pusher,
            botIdentity: await botLoginFor(input.provider),
            ...workflowPush,
          })
        : false;
      if (!pusher) {
        const { logger } = await import("../../services/system/logger.js");
        logger.warn(
          { integration: id, provider: input.provider, prNumber: input.prNumber },
          "webhook_push_author_unknown",
        );
      }
    }
    if (retryable) {
      const { logger } = await import("../../services/system/logger.js");
      logger.info({ integration: id, ...retryable }, "trigger_webhook_retryable_failure");
      throw createError({
        statusCode: 503,
        statusMessage: retryable.reason,
        ...(retryable.diagnosticId ? { data: { diagnosticId: retryable.diagnosticId } } : {}),
      });
    }
    if (
      !claimed &&
      !suppressedWorkflowPush &&
      reception.legacyGate &&
      isRepositoryDispatchable(repositoryCatalog, {
        provider: reception.legacyGate.workflowInput.provider,
        path: reception.legacyGate.workflowInput.ownerRepo,
      })
    ) {
      await dispatchPostPrGateWebhook(reception.legacyGate);
      gateDispatched = true;
    }
    // What the delivery log says, in the order that matters to whoever reads
    // it: an event core could not act on first, because that is the one an
    // operator has to do something about, then what did start.
    const verdict = ignoredReason
      ? { status: "ignored", reason: ignoredReason }
      : dispatched
        ? { status: "dispatched", ...dispatched }
        : suppressedWorkflowPush
          ? { status: "ignored", reason: "workflow_generated_push" }
          : gateDispatched
            ? { status: "dispatched", reason: "post_pr_gate" }
            : undefined;
    return respond(event, {
      ...reception.response,
      ...(verdict ? { body: verdict } : {}),
    });
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

/**
 * One automation-account lookup per provider, per delivery.
 *
 * `getVcsBotLogin` resolves every connected version control integration to
 * decide whether a legacy single-provider login still applies, so each call is
 * a settings read. One delivery asks for the same provider once per candidate
 * event and again for the legacy gate, which was the same answer bought several
 * times inside a deadline of about three seconds. The promise is cached rather
 * than the value, so two questions in one tick share the read instead of
 * starting two.
 */
function memoizedVcsBotLogin(): (provider: string) => Promise<string | undefined> {
  const byProvider = new Map<string, Promise<string | undefined>>();
  return (provider) => {
    const pending = byProvider.get(provider);
    if (pending) return pending;
    const started = (async () => {
      const { readVcsBotLogin } = await import("../../services/vcs/index.js");
      const reading = await readVcsBotLogin(provider);
      // FAILS CLOSED, like the first settings read one screen up. This is a
      // SECOND read and it can fail on its own, and a delivery acted on with
      // an unknown automation account is how the workflow answers its own
      // review and starts a run off its own push: every comment it made reads
      // as somebody else's.
      if (!reading.readable) {
        throw createError({
          statusCode: 503,
          statusMessage: `The automation account for ${provider} could not be read on this deployment (${reading.reason}), so the delivery was not acted on.`,
        });
      }
      return reading.login;
    })();
    byProvider.set(provider, started);
    return started;
  };
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

/**
 * Record ingress without making a provider wait on the database.
 *
 * The scope is deliberately the deployment default. Core neither reads nor
 * hashes the integration's signing secret, so every integration webhook can
 * use the same observation check without widening its secret boundary.
 */
function observeWebhook(
  integrationId: string,
  outcome: "accepted" | "rejected",
  reason: string,
): void {
  const write = (async () => {
    const { recordSystemHealthObservation } = await import(
      "../../services/system/observations.js"
    );
    await recordSystemHealthObservation({
      integrationId,
      checkId: "webhook-delivery",
      outcome,
      reason,
    });
  })().catch(async (error: unknown) => {
    const { logger } = await import("../../services/system/logger.js");
    logger.warn(
      {
        integration: integrationId,
        outcome,
        reason,
        error: error instanceof Error ? error.message : String(error),
      },
      "integration_webhook_observation_failed",
    );
  });
  waitUntil(write);
}
