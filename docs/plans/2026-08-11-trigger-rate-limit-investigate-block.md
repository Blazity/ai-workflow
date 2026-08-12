# Trigger rate limit + Investigate block

Sources: [AIW-256](https://blazity.atlassian.net/browse/AIW-256) (configurable rate limits for workflow triggers) and [AIW-257](https://blazity.atlassian.net/browse/AIW-257) (provider-aware Jira and Slack investigation blocks), plus the repository evidence cited inline below. Two independent features in one sprint: (A) a configurable cap on workflow starts per trigger, (B) the Investigate block (Jira + Slack context search -> theory with evidence -> human decision). **Priority: A is critical and lands first; B may slip by a few days.**

Version 2 - after the skeptic's pre-mortem (10 findings, triaged under "Assumptions").

## Problem

- A: today 100 tickets on the board means 100 jobs, so 100x the cost; an attack or a loop on a trigger burns tokens. A limit exists only for custom webhooks (60/min per endpoint, `apps/worker/src/webhook-trigger/rate-limit.ts:9`).
- B: a ticket arriving from a board or from Zendesk gets no context investigation at all, so we cannot tell a duplicate from a known issue from a real bug. Either we open a PR blind, or a human searches Jira and Slack by hand.

## Solution

- A: the operator sets "max N starts per minute/hour/day/month" on the trigger node; excess starts are refused and visible as a rejection counter instead of becoming runs. The counter is spent ONLY by a genuinely new start (never by a candidate the duplicate or already-claimed guard refused).
- B: a new `investigate` block in the graph: it extracts keywords from the ticket (LLM), searches Jira (similar tickets) and the configured Slack channels (history + local matching), assembles a theory with evidence (false_positive / known_issue / real_bug / feature_request / question / insufficient_data) and passes it on in the graph, typically to `human_question`, where a human decides about a PR.

## User stories

1. As a workflow operator I want a per-trigger start limit, so a flood of tickets cannot burn the token budget.
2. As an operator I want to see the number of refused starts, so I know the limit works and whether it is too tight.
3. As an operator I want existing workflows without configuration to behave exactly as before (unlimited), so the rollout breaks nothing.
4. As a ticket triager I want a theory with evidence (similar Jira tickets, Slack threads), so I can decide whether the ticket deserves a PR.
5. As a triager I want non-code tickets (questions about how something works) filtered out without creating a PR.
6. As an operator I want a ticket with a live or finished run not to consume the limit on every poll, so the limit measures real new starts.

## Implementation decisions

### A: rate limit

- Configuration lives in the trigger node's parameters (decision Q1): `rateLimitMax: number` + `rateLimitWindow: "minute" | "hour" | "day" | "month"` on the types `trigger_ticket_ai`, `trigger_pr_*`, `trigger_schedule`, `trigger_webhook`. Both optional; absent means unlimited (Q3). An optional global default comes from the env vars `TRIGGER_RATE_LIMIT_MAX` + `TRIGGER_RATE_LIMIT_WINDOW`: applied ONLY when the node has no parameters of its own (a default, not a ceiling; node parameters always win). With the env unset nothing changes for existing workflows (story 3).
- Enforcement: a shared module `apps/worker/src/lib/trigger-rate-limit.ts`, mirroring `webhook-trigger/rate-limit.ts`: fixed window, SQL upsert `INSERT ... ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`, time passed in explicitly as a parameter (testability, `rate-limit.test.ts:38-51`).
- **GUARD ORDER (pre-mortem fix #1):** the limit check in the dispatcher stands AFTER the duplicate and already-claimed/already-running guards, and BEFORE the actual start of the run. A candidate refused by the duplicate guard does NOT spend the limit. The Jira poller (`routes/cron/poll.get.ts:484`) re-reads every ticket in the AI column once a minute, so without this order the backlog would hold itself above the limit in every window.
- Counter key: `(definition_id, node_id, window_kind, window_start)`, so the limit is per trigger node and per window kind. The kind is part of the key because `window_start` alone does not identify a window: at 00:00 UTC on the first of a month all four kinds floor to the same instant, so a node whose window an operator just changed would otherwise inherit the count of the window it left. **Several nodes of the same type (pre-mortem fix #6):** where the dispatcher resolves the definition by type rather than by node (`store.ts:496`, which covers Jira and PR triggers), apply the SMALLEST (most restrictive) configured limit among the nodes of that type in the definition. Webhook and schedule know their node_id from their own configuration row, so their key is exact.
- Enforcement points: the 4 dispatchers around `claimSubjectRun` (`lib/dispatch.ts:154`): `dispatchTicket` (Jira, `lib/dispatch.ts:57`), `dispatchAcceptedTrigger` (PR, `lib/dispatch-trigger.ts:443`), `startAdmittedOccurrence` (schedule, `schedule-trigger/dispatch-schedule-trigger.ts:325`), `dispatchWebhookDelivery` (webhook, `webhook-trigger/dispatch-webhook-trigger.ts:213`).
- Exceeding the limit (Q2): drop plus a rejection counter. Schedule: skip the occurrence (consistent with `overlap_policy: skip`). Jira/PR: drop with the counter. **Webhook (advisor's decision after pre-mortem #2):** enforcement stays in `dispatchWebhookDelivery` (async, after the 202), and the delivery gets the terminal outcome `"rejected"` with reason `rate_limited` (an existing pattern, `dispatch-webhook-trigger.ts:264-272`). Deliberately NOT a 429 on the POST: Zendesk deactivates webhook targets after a run of 4xx answers, so a flood of 429s would kill the customer's integration worse than dropped tickets do. The existing endpoint limits (600/min ingress, 60/min inbox) stay unchanged as an independent layer; the node limit is additional, and the field description in the UI says so.
- New tables: `trigger_rate_limits` (PK `(definition_id, node_id, window_kind, window_start)`) plus `trigger_rejection_counters` (a daily upsert per `(definition_id, node_id, reason)`, 30-day retention, swept by the cron - mirroring `rejection-counters.ts:24-46`).
- Visibility (Q8 + pre-mortem fix #4): the rejection counter must be REALLY visible for all 4 trigger types - read `trigger_rejection_counters` from the existing telemetry/configuration surface of the trigger node in the dashboard (not a new screen, but not "only in the database" either).
- Scope (Q11): automatic triggers only. Manual dispatch (`manual-dispatch/service.ts:487`) and restarts from approvals (`approvals/dispatch.ts:80`) are not limited.
- Window semantics (pre-mortem fix #8): fixed window, a month is the UTC calendar month; on a window boundary a burst of up to 2x the limit is possible - one sentence about it in the field description in the UI.

### B: Investigate block

- A new block type `investigate` (action category, `allowsFailurePort: true`): `shared/contracts/domain.ts:253-290` (the type union), `workflow-graph.ts:42-80` (`BLOCK_TYPE_SPECS`) plus `BLOCK_PARAM_KEYS`.
- Parameters: `providers: ("jira" | "slack")[]` (a flat selection list, like the VCS providers on the PR triggers, because a node parameter can only hold `string | number | boolean | string[]`), `slackChannels: string[]` (a list of channel IDs, Q9; empty means Slack is skipped), `slackLookbackDays: number` (default 30 - pre-mortem fix #5), `jiraJqlTemplate?: string`, `maxResults: number` (default 10), `model?: string` (mirroring the `call_llm` parameter).
- The pipeline inside the block (decision Q4 - retrieval and theory in one block):
  1. Extract keywords from the ticket with an LLM (decision Q6) - `generateStructured` from `apps/worker/src/lib/llm.ts:73`. The prompt produces keywords in English AND in the ticket's own language (pre-mortem fix #9). A ticket with neither summary nor description returns `classification: "insufficient_data"` immediately, with empty evidence and ZERO retrieval calls.
  2. Retrieval: Jira - a new adapter method (alongside `searchTickets`, `jira.ts:271`) returning `{ key, summary, status, url }[]` (trimmed to `maxResults`). Slack - a new module `lib/slack-search.ts`: `conversations.history` per configured channel, with `oldest = now - slackLookbackDays`, pagination capped hard at 3 pages (~300 messages) per channel, local case-insensitive keyword matching, top N hits; permalinks via `chat.getPermalink` for the top N (N <= maxResults <= 10, negligible cost - the fix for the attack on assumption 6).
  3. Theory: a second `generateStructured` - a prompt with the ticket plus the evidence -> `{ classification, theory, evidenceRefs }`.
- Per-provider degradation (Q10): a Jira or Slack failure (including a channel without the bot / `not_in_channel`) means that provider is skipped, `partial: ["jira" | "slack"]` names which provider is incomplete and `partialReasons: [{ provider, reason, scope }]` says why (`permission` / `timeout` / `unavailable`, with `scope` naming a single Slack channel when only that channel was missed); an LLM failure fails the block.
- **Flow termination (pre-mortem fix #3):** a graph containing `investigate` MUST end in a ticket mutation (label/transition) or in `human_question` - otherwise the ticket stays in the AI column and the poller fires the investigation in a loop every minute (2 LLM calls per minute per ticket). The block itself does NOT mutate the ticket. This requirement goes into: the block description in the registry, the DoD of stage 5 (test/validation) and the pre-trial checklist. The `question`/`known_issue` classifications, which have no downstream code path, should lead to answering the ticket plus a transition rather than to a PR (story 5).
- Output: `statusOutput` carrying `{ classification, theory, evidence: [...], partial: string[], partialReasons: [...] }` - the contract lives in `block-registry.ts:211` and conforms to `expectOutputConformsToRegistry` (`blocks/test-support.ts`).
- LLM: the same stack as `call_llm` (`blocks/call-llm.ts` + `lib/llm.ts`) - Anthropic/Codex via `resolveLlmProvider`, with a 4 minute upper bound.

## Seams and testing decisions

- **Rate limit: the `trigger-rate-limit.ts` module on PGlite** - mirroring `rate-limit.test.ts`: real migrations on an in-memory PGlite (`src/db/test-db.ts:14`), time as a parameter. What we observe: allowed and refused starts on a window boundary, and independence between keys. (confirmed in Q7, TDD: yes)
- **Dispatchers: dispatcher/route-level tests** - mirroring the 429-plus-counter assertions in `[endpointId].post.test.ts:485`. What we observe: an exceeded limit means no run plus a counter; the duplicate guard does NOT spend the limit (guard order). (TDD: yes)
- **Investigate executor: `vi.mock` of the adapters plus `vi.mock` of lib/llm** - mirroring `post-ticket-comment.test.ts:8-14`. What we observe: keyword assembly (bilingual), insufficient_data without retrieval, per-provider degradation, and the output contract. (confirmed in Q7, TDD: yes)
- **Pure retrieval functions**: building the JQL from a template, keyword matching/scoring over Slack history, computing `oldest` - pure functions, unit-tested without mocks.

## Out of scope

- Guardrails (blocking files/actions for the agent) - a separate backlog ticket.
- Renaming BlazeBot -> workflow and migrating memory - separate work.
- Queueing/deferring the starts that exceed the limit (rejected in Q2).
- A dedicated rate-limit screen in the dashboard (Q8; the counter lands in existing surfaces).
- A "do not redispatch a ticket after success unless the ticket changed" guard at the `dispatchTicket` level - globally risky; mitigated by the flow-termination requirement above. A candidate for its own ticket if the loop shows up in practice.
- Zendesk as a native Investigate provider (v1: the ticket arrives by webhook, the context comes from Jira and Slack).
- Multi-tenant credentials per repo/org (they are global env today, `adapters.ts:44-48`).

## Assumptions (from the pre-mortem triage)

1. **The Slack bot must be invited to the channels in the configuration** - this is a precondition for the trial, not just documentation: it is a pre-trial checklist item, verified on a real customer channel. A channel without the bot means `partial` degradation, but `human_question` may not show the partial field - so it has to appear in the theory ("Slack: not checked").
2. **Webhook: a silent drop instead of a 429** - the advisor's decision (rationale in section A): Zendesk deactivates targets after a run of 4xx answers. The risk is a ticket disappearing silently; the mitigation is the visible rejection counter (a requirement of stage 3).
3. **Cloning a workflow means a fresh counter** (the key is `(definition_id, node_id)`): during the trial week the user experiments with clones, and the limit "resets" on each clone. Accepted deliberately - the alternative (a key stable across definitions) does not exist in the data model.
4. **The model for Investigate**: the default from the model registry, as in `call_llm`. Cost: 2 LLM calls per block run; with feature A's limit of N starts per day, the cost ceiling is N x 2 calls - the recommendation is to keep the default cheap but not the cheapest (the false_positive vs real_bug classification drives a human decision).
5. **Three limits on a webhook** (600/min ingress, 60/min inbox, node): a user who sets the node to 100/min is still cut at 60/min by the inbox limit. Accepted; described in the field description.
6. **Fixed window plus a UTC month**: the 2x burst on a window boundary is accepted; the UI says so (decisions in A). A rolling window is rejected: the complexity cost is out of proportion to the risk.
7. **The interaction between the two features:** the rate limit (A) masks an investigate loop (B) - on graphs without a limit, B's loop is unbounded. Recommendation: the investigate template ships with a default limit set, in the docs rather than in code.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | A1: parameter contract + rate limit module + migration | `checkAndIncrementTriggerRate` on PGlite | `apps/shared/contracts/workflow-graph.ts` (trigger param keys), `apps/worker/src/workflow-definition/schema.ts` (trigger literals), `apps/worker/src/db/schema.ts`, `apps/worker/drizzle/0047_*.sql`, `apps/worker/src/lib/trigger-rate-limit.ts`(+.test.ts) | sonnet | no | yes | no | `pnpm --filter worker test -- trigger-rate-limit` green (window boundary, key independence, the min-limit multi-node helper); `pnpm --filter worker typecheck` green |
| 2 | B1: retrieval providers (Jira ext + Slack history) | pure fns (JQL build, keyword match, oldest) + mocked adapters | `apps/worker/src/adapters/issue-tracker/jira.ts`(+.test), `types.ts`, `apps/worker/src/lib/slack-search.ts`(+.test), `apps/worker/src/adapters/messaging/chatsdk.ts` | sonnet | no | yes | no | targeted jira/slack-search tests green (lookback `oldest`, the 3-page pagination cap, bilingual matching, permalinks); typecheck green |
| 3 | D: dashboard - trigger rate limit fields + investigate config + rejection counter + env | none (UI from the description) | `apps/dashboard/**/config-fields.tsx`, `apps/dashboard/**/blocks.ts` (THESE FILES WHOLE - single owner), `apps/worker/env.ts`, an endpoint/API for reading `trigger_rejection_counters` if none exists | sonnet | no | no | no | `pnpm --filter ai-workflow-dashboard test` and `typecheck` green; the fields render for all 4 trigger types and for investigate; the rejection counter is visible for every trigger type; the field descriptions cover the fixed-window semantics (2x burst) and the interaction of the webhook's three limits |
| 4 | A2: enforcement in the 4 dispatchers + counters | dispatcher tests (mirroring `[endpointId].post.test.ts`) | `apps/worker/src/lib/dispatch.ts`, `lib/dispatch-trigger.ts`, `schedule-trigger/dispatch-schedule-trigger.ts`, `webhook-trigger/dispatch-webhook-trigger.ts`(+tests), `routes/cron/poll.get.ts` (counter sweep) | sonnet | yes | yes | no | targeted tests green: the limit refuses a new start; the duplicate/already-claimed guard does NOT spend the limit; unlimited behaves exactly as before; the webhook rejected-outcome carries the counter; typecheck |
| 5 | B2: investigate block end to end | executor + `vi.mock` of the adapters/llm | `apps/shared/contracts/domain.ts`, `apps/shared/contracts/workflow-graph.ts` (block spec), `apps/worker/src/workflow-definition/block-registry.ts`, `schema.ts` (the investigate literal), `apps/worker/src/workflows/blocks/investigate.ts`(+.test) | opus | yes | yes | no | `investigate.test.ts` green: bilingual keywords; insufficient_data without retrieval; per-provider degradation; the output conforms to the registry contract; the block description carries the flow-termination requirement; `pnpm --filter worker test -- block-registry schema` green; typecheck |

Dependencies: wave 1 = stages 1, 2, 3 in parallel (disjoint files; the parameter names and the block type are frozen by this plan). Wave 2 = stages 4 and 5 in parallel (4 after 1; 5 after 1 and 2 - it touches `workflow-graph.ts` and `schema.ts` once A1 releases them).

## Pre-trial checklist

1. The Slack bot is invited to the channels in the investigate configuration - verified on a real channel (one manual run on the customer's environment).
2. One end-to-end run on the customer's environment: ticket -> investigate -> theory -> human_question (dogfooding, not an integration test).
3. The demo graph with investigate HAS a rate limit set and a termination path (label/transition/human_question) for every classification.
4. Smoke test: a flood test on a trigger with a limit (for example 20 quick tickets) - the refusals are visible in the counter in the UI.
