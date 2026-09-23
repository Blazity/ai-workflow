import { randomUUID } from "node:crypto";
import { createError, defineEventHandler, getQuery, getRequestHeaders, readRawBody } from "h3";
import { waitUntil } from "@vercel/functions";
import { EXECUTION_DIAGNOSTIC_PREFIX } from "@shared/contracts";

/**
 * Every integration's webhook, at the URL its provider already calls.
 *
 * `/webhooks/slack`, `/webhooks/github`, `/webhooks/jira` and every other
 * integration callback land here. Only core's own routes
 * (`/webhooks/custom/...`, `/webhooks/resend`) keep their own files and win,
 * because a static route beats a dynamic one. Each provider keeps the URL it
 * already calls whichever side of that line it is on.
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
  const { getRequestSettingsSnapshot } = await import("../../services/settings/index.js");
  // A request has one deadline for everything it does with the contexts, so
  // it is their lifetime: this integration's, and the one dispatch resolves
  // to read the pull request. Resolved for the webhook: served on the fields
  // the integration says its webhook reads, with the operator settings it
  // declares read now, from this request's one settings snapshot.
  const lifetime = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  const resolved = await resolveUsableIntegrations({
    lifetime,
    filter: (candidate) => candidate.id === id,
    forWebhook: { settings: () => getRequestSettingsSnapshot(event) },
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
    // Connected for everything else and still not served is a webhook that
    // declared fields this deployment has no value for (Slack's signing
    // secret): name them, since "not connected" would send an admin looking
    // at a connection that works.
    const requires = manifest.webhook?.requires;
    const needs =
      state?.connection === "connected" && requires
        ? manifest.connection.fields
            .filter((field) => requires.includes(field.key))
            .map((field) => field.label)
        : [];
    throw createError({
      statusCode: 503,
      statusMessage:
        needs.length > 0
          ? `${manifest.name}'s webhook needs its ${needs.join(" and ")} on this deployment, and it is not set or cannot be read.`
          : `${manifest.name} is not connected on this deployment.`,
    });
  }
  // The resolved runtime's webhook, not the registry's: it throws with this
  // connection's secrets already redacted (`redactingRuntime` in
  // `services/integrations/usable.ts`), so nothing below has to remember to.
  const calls = usable.runtime.webhook ?? webhook;

  // One automation-account read per delivery, and only after the integration
  // has verified the request: a delivery with a bad signature or token costs
  // the connection read above and nothing more. The integration sees its own
  // connection, whose bot login field is at most a first filter; core filters
  // review authors and producers again against the resolved account (the
  // legacy single-provider login included) in `selectEligibleEvent`.
  const readBotLogin = memoizedVcsBotLogin();
  const { VCS_LEGACY_BOT_LOGIN_FIELD } = await import("@integrations/sdk");
  const { [VCS_LEGACY_BOT_LOGIN_FIELD.key]: _legacyBotLogin, ...connection } = usable.ctx.connection;
  let reception;
  try {
    reception = await calls.receive(
      {
        method: event.method,
        rawBody,
        headers: lowercased(getRequestHeaders(event)),
        query: stringValues(getQuery(event)),
      } as never,
      { ...usable.ctx, connection } as never,
    );
  } catch (error) {
    observeWebhook(id, "rejected", "handler_failed");
    throw error;
  }

  if (reception.kind === "refused") {
    observeWebhook(id, "rejected", `request_refused_${reception.status}`);
    throw createError({ statusCode: reception.status, statusMessage: reception.reason });
  }
  if (reception.kind === "answered") {
    observeWebhook(id, "accepted", "request_accepted");
    return respond(event, reception.response);
  }
  if (reception.kind === "ticket_events") {
    // The integration read its provider's bytes and said what happened to a
    // ticket. What that means for a run is core's, and it is the same for the
    // next issue tracker: see `services/triggers/ticket-events.ts`.
    if (reception.events.length === 0) {
      observeWebhook(id, "accepted", "request_accepted");
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
    observeWebhook(id, "accepted", "request_accepted");
    return respond(event, { ...reception.response, ...(outcome ? { body: outcome } : {}) });
  }

  if (reception.kind === "trigger_events") {
    // The same rule as the ticket branch above: the delivery log's last word
    // is written once the outcome is known, so a delivery this deployment
    // failed to act on never reads as accepted.
    let verdict: TriggerDeliveryVerdict;
    try {
      verdict = await actOnTriggerEvents(event, id, reception, readBotLogin, lifetime);
    } catch (error) {
      observeWebhook(id, "rejected", "handler_failed");
      throw error;
    }
    if (verdict.kind === "retry") {
      // A fault of this deployment, and rare. It answers 5xx so it is red in
      // the provider's log and can be redelivered by hand.
      observeWebhook(id, "rejected", verdict.reason);
      const { logger } = await import("../../services/system/logger.js");
      logger.info(
        {
          integration: id,
          reason: verdict.reason,
          ...(verdict.diagnosticId ? { diagnosticId: verdict.diagnosticId } : {}),
        },
        "trigger_webhook_retryable_failure",
      );
      throw createError({
        statusCode: 503,
        statusMessage: verdict.reason,
        ...(verdict.diagnosticId ? { data: { diagnosticId: verdict.diagnosticId } } : {}),
      });
    }
    if (verdict.kind === "answer" && verdict.rejectedAs) {
      observeWebhook(id, "rejected", verdict.rejectedAs);
    } else {
      observeWebhook(id, "accepted", "request_accepted");
    }
    return respond(event, {
      ...reception.response,
      ...(verdict.kind === "answer" ? { body: verdict.body } : {}),
    });
  }

  observeWebhook(id, "accepted", "request_accepted");
  const { logger } = await import("../../services/system/logger.js");
  if (!calls.deliver) {
    // The command still runs: it is what the person asked for. That the answer
    // cannot come back is a defect of the integration, and it is said here
    // rather than swallowed.
    logger.warn({ integration: id }, "integration_webhook_reply_undeliverable");
  }
  waitUntil(
    runAndDeliver(id, reception, usable, calls.deliver).catch((error: unknown) =>
      logger.error(
        { integration: id, error: error instanceof Error ? error.message : String(error) },
        "integration_webhook_delivery_failed",
      ),
    ),
  );
  return respond(event, reception.response);
});

/**
 * What core did with a delivery of trigger events, as the one value the
 * answer and the delivery log are both written from.
 *
 * - `retry`: this deployment failed to act and the provider should redeliver.
 * - `answer`: what the provider's delivery log shows beside the event. The
 *   integration's own `response` was decided before dispatch and can only say
 *   whether there was anything to dispatch, so an event for a repository
 *   nobody enabled would read as accepted with nowhere to see nothing ran.
 *   `rejectedAs`: answered 2xx, recorded as rejected, for a fault that lasts
 *   until an operator repairs something. The health row is where they see
 *   it; a 5xx would say it only to GitLab, which switches the webhook off.
 * - `unchanged`: there was nothing to act on, and the integration said so.
 */
type TriggerDeliveryVerdict =
  | { kind: "retry"; reason: string; diagnosticId?: string }
  | {
      kind: "answer";
      body:
        | { status: "dispatched"; runId?: string; reason?: string }
        | { status: "queued" }
        | { status: "ignored"; reason: string; diagnosticId?: string };
      rejectedAs?: string;
    }
  | { kind: "unchanged" };

/**
 * Results that leave a delivery unclaimed, so the next candidate event or the
 * legacy post-PR gate may take it. Every other result means the definition
 * that answered owns the delivery, whether or not a run started for it.
 */
const UNCLAIMED_RESULTS: ReadonlySet<string> = new Set([
  "no_definition",
  "ignored_not_workflow_owned",
  "ignored_provider",
  "ignored_repository_not_enabled",
]);

async function actOnTriggerEvents(
  event: Parameters<typeof getQuery>[0],
  id: string,
  reception: Extract<
    import("@integrations/sdk").IntegrationWebhookReception,
    { kind: "trigger_events" }
  >,
  readBotLogin: VcsBotLoginReader,
  /** The request's deadline, which dispatch's pull request read ends with. */
  lifetime: AbortSignal,
): Promise<TriggerDeliveryVerdict> {
  const { getRequestSettingsSnapshot, maxConcurrentAgents } = await import(
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
    recordIngestionFailure,
  } = await import("../../services/dispatch/index.js");
  const { connectedWorkflowPushNormalizationOptions, isWorkflowGeneratedPush } = await import(
    "../../services/publication/index.js"
  );
  const { logger } = await import("../../services/system/logger.js");
  const [settings, repositoryCatalog] = await Promise.all([
    getRequestSettingsSnapshot(event),
    getRequestRepositoryCatalogSnapshot(event),
  ]);

  /**
   * Whether a push is one this workflow made, from its ownership record, or a
   * retry verdict when the automation account could not be read. That FAILS
   * CLOSED: acted on without the account, every commit the workflow made
   * reads as somebody else's, and it starts a run off its own push. The
   * verdict is the one dispatch's own unreadable account turns into.
   */
  const isOurPush = async (push: {
    provider: string;
    repoPath: string;
    prNumber: number;
    headSha: string;
    pusher: string;
  }): Promise<boolean | Extract<TriggerDeliveryVerdict, { kind: "retry" }>> => {
    const reading = await readBotLogin(push.provider);
    if (!reading.readable) {
      return {
        kind: "retry",
        reason: "bot_login_unreadable",
        diagnosticId: recordIngestionFailure("trigger_bot_login_unreadable", new Error(reading.reason), {
          integration: id,
          provider: push.provider,
        }),
      };
    }
    return isWorkflowGeneratedPush({
      currentHeadSha: push.headSha,
      producer: push.pusher,
      botIdentity: reading.login,
      ...(await connectedWorkflowPushNormalizationOptions({
        provider: push.provider,
        repoPath: push.repoPath,
        prNumber: push.prNumber,
      })),
    });
  };

  let suppressedWorkflowPush = false;
  // Why the last candidate that did not claim the delivery did not. The loop
  // stops at the first that claims, so this is only read when none did.
  let unclaimedReason: string | undefined;
  for (const candidate of reception.events) {
    const ours =
      candidate.triggerType === "trigger_pr_updated" &&
      (await isOurPush({ ...candidate.pr, pusher: candidate.delivery.producer }));
    if (typeof ours === "object") return ours;
    if (ours) {
      suppressedWorkflowPush = true;
      continue;
    }
    const result = await dispatchTriggerEvent(candidate, {
      runRegistry: createConnectedTriggerRunRegistry(),
      maxConcurrentAgents: maxConcurrentAgents(settings),
      repositoryCatalog,
      readBotLogin,
      lifetime,
    });
    if (result.result === "error") {
      return { kind: "retry", reason: "trigger_error", diagnosticId: result.diagnosticId };
    }
    if (UNCLAIMED_RESULTS.has(result.result)) {
      unclaimedReason = result.result;
      continue;
    }
    // Claimed. AT CAPACITY IS NOT A FAILED DELIVERY either: nothing is wrong
    // with what the provider sent, and GitLab switches a webhook off after a
    // few consecutive failures, so a 5xx here would trade one missed event for
    // every later one. Like every other claim, it says what happened.
    if (result.result === "started") {
      return { kind: "answer", body: { status: "dispatched", runId: result.runId } };
    }
    // Kept, and started by the drain once the pull request's current run or
    // the deployment has room. A drop (a rate limit, the fix-attempt cap)
    // reads as ignored below, under its reason: no run will follow it.
    if (result.result === "coalesced") return { kind: "answer", body: { status: "queued" } };
    return {
      kind: "answer",
      body: {
        status: "ignored",
        reason: result.result,
        ...("diagnosticId" in result ? { diagnosticId: result.diagnosticId } : {}),
      },
      ...(result.result === "vcs_credential_refused" ? { rejectedAs: result.result } : {}),
    };
  }

  const gate = reception.legacyGate;
  if (gate && gate.headMoved === true && !suppressedWorkflowPush) {
    // Who PUSHED, never the pull request's author: on a pull request this
    // product opened the author is our own account, so asking the author
    // would suppress every human push and skip the gate on it. An integration
    // that did not say who pushed suppresses nothing, which runs the gate:
    // checking a change twice costs a run, skipping the check on somebody's
    // change costs the review it exists for.
    if (!gate.pusher) {
      logger.warn(
        {
          integration: id,
          provider: gate.workflowInput.provider,
          prNumber: gate.workflowInput.prNumber,
        },
        "webhook_push_author_unknown",
      );
    } else {
      const ours = await isOurPush({
        provider: gate.workflowInput.provider,
        repoPath: gate.workflowInput.ownerRepo,
        prNumber: gate.workflowInput.prNumber,
        headSha: gate.workflowInput.headSha,
        pusher: gate.pusher,
      });
      if (typeof ours === "object") return ours;
      suppressedWorkflowPush = ours;
    }
  }
  if (gate && !suppressedWorkflowPush) {
    const { provider, ownerRepo } = gate.workflowInput;
    if (!isRepositoryDispatchable(repositoryCatalog, { provider, path: ownerRepo })) {
      // Provider and path, because that pair is the catalog key an operator
      // has to find on the Repositories page to answer this.
      logger.info(
        { integration: id, provider, repoPath: ownerRepo },
        "legacy_gate_skipped_repo_not_enabled_in_catalog",
      );
      return {
        kind: "answer",
        body: { status: "ignored", reason: "ignored_repository_not_enabled" },
      };
    }
    // The gate's own answer, not the fact that it was asked: it refuses a
    // branch it does not own, a draft, a busy lock, a head it already claimed.
    const outcome: { status: string; reason?: string; runId?: string } =
      await dispatchPostPrGateWebhook(gate);
    return {
      kind: "answer",
      body:
        outcome.status === "dispatched"
          ? {
              status: "dispatched",
              reason: "post_pr_gate",
              ...(outcome.runId ? { runId: outcome.runId } : {}),
            }
          : { status: "ignored", reason: outcome.reason ?? "post_pr_gate_ignored" },
    };
  }
  if (suppressedWorkflowPush) {
    return { kind: "answer", body: { status: "ignored", reason: "workflow_generated_push" } };
  }
  if (unclaimedReason) {
    return { kind: "answer", body: { status: "ignored", reason: unclaimedReason } };
  }
  return { kind: "unchanged" };
}

/**
 * Run the command and hand whatever came of it back.
 *
 * A failure is delivered rather than logged and dropped: the person is
 * watching an acknowledgement that promised an answer, and silence is the one
 * outcome they cannot act on. What is delivered is a reference, never the
 * error: core's errors are written for this log (a failed query quotes its SQL
 * and its parameters), and the answer lands in a chat channel that may be
 * shared with another company. The log line carries the same reference, so an
 * admin handed it finds the error.
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
  let outcome: { kind: "answered"; answer: unknown } | { kind: "failed"; reference: string };
  try {
    const answer = await executeRunControlCommand(
      reception.command as never,
      await runControlDeps(),
    );
    outcome = { kind: "answered", answer };
  } catch (error) {
    const reference = `${EXECUTION_DIAGNOSTIC_PREFIX}run-control-${randomUUID()}`;
    logger.error(
      {
        integration: id,
        command: (reception.command as { kind?: unknown } | null)?.kind,
        diagnosticId: reference,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      },
      "run_control_command_failed",
    );
    outcome = { kind: "failed", reference };
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

type VcsBotLoginReader = (
  provider: string,
) => Promise<{ readable: true; login: string | undefined } | { readable: false; reason: string }>;

/**
 * One automation-account lookup per provider, per delivery.
 *
 * `readVcsBotLogin` resolves every connected version control integration to
 * decide whether a legacy single-provider login still applies, so each call is
 * a settings read. One delivery asks for the same provider once per candidate
 * event, again inside dispatch for a review, and again for the legacy gate,
 * which was the same answer bought several times inside a deadline of about
 * three seconds. The promise is cached rather than the value, so two questions
 * in one tick share the read instead of starting two.
 */
function memoizedVcsBotLogin(): VcsBotLoginReader {
  const byProvider = new Map<string, ReturnType<VcsBotLoginReader>>();
  return (provider) => {
    const pending = byProvider.get(provider);
    if (pending) return pending;
    const started = (async () => {
      const { readVcsBotLogin } = await import("../../services/vcs/index.js");
      return readVcsBotLogin(provider);
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
 * Record ingress without making a provider wait on the database, under this
 * deployment's own scope (see `recordWebhookDelivery`), which is the one the
 * health page reads back.
 */
function observeWebhook(
  integrationId: string,
  outcome: "accepted" | "rejected",
  reason: string,
): void {
  const write = (async () => {
    const { recordWebhookDelivery } = await import("../../services/system/observations.js");
    await recordWebhookDelivery({ integrationId, outcome, reason });
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
