# Production MCP Real-Run Stress-Test Plan

**Status:** Prepared, not started
**Target:** shared source production in a dedicated test scope
**Explicit exclusion:** Arthur tenant and Arthur production
**Control plane:** MCP, with Jira, Slack, GitHub/GitLab, and webhook tools only where the trigger itself requires them

## Purpose

This campaign proves that the integrated product behaves correctly under real execution, not only under mocked tests. It exercises the complete path from workflow authoring and external triggers through agent execution, human input, publication, observability, recovery, and cleanup.

It is intentionally broader than the MCP contract dogfood harness. The harness proves that every MCP tool exists, authenticates, validates input, and returns the published envelope. This plan uses those tools to create and observe real workflows and real runs, then applies controlled concurrency and failure conditions.

The campaign starts only after the source baseline is clean:

- focused local tests, worker typecheck, production build checks, generated-artifact checks, and combined-main smoke checks are green; CI is informational and not the acceptance gate;
- the canonical MCP endpoint `https://ai-workflow-app-eight.vercel.app` points to deployment `dpl_6vS3JVz5zNQUCezQMkbYpexQEeQo` at commit `bbdcc5ac`;
- the committed/local target remains 22 tools, 11 errors, and hash `881de2fae17a183a44645d8d6c6c8c8089e604fcc2197d98d4f27acb66ec2f7b`; authenticated production `tools/list`, `system.capabilities`, and exact-hash verification are still pending;
- `GET /mcp` returns 405, unauthenticated initialize returns 401 with `mcp:read`, and protected-resource metadata returns 200;
- AIW-273 source deployment is present, but interactive signed-in dashboard-session OAuth handoff verification remains pending because the Chrome session is unavailable;
- AIW-274 is merged via [PR #275](https://github.com/Blazity/ai-workflow/pull/275) at `bbdcc5ac`; its 110 focused tests and worker typecheck passed, while the live Jira/DB race is explicitly a stress-verification case;
- AIW-276 is merged via [PR #274](https://github.com/Blazity/ai-workflow/pull/274) and production verified; the zod/v3 Vercel pre-auth crash is fixed;
- AIW-271 historical production-row cleanup verification remains pending and must be explicitly recorded before the baseline is accepted;
- Jira and the roadmap agree with merged code;
- no unrelated deployment is running;
- run volume and cost guardrails must be agreed before Wave 0.

This document is a prepared plan only. No broad stress testing is claimed here, and Arthur remains held until Filip approves.

## Safety boundaries

- Never deploy, reconfigure, or test against Arthur without a separate explicit approval.
- Never use Playwright. Agents use MCP and provider APIs; browser access is reserved for a human-only OAuth consent step when unavoidable.
- Use dedicated test tickets, workflows, schedules, webhook secrets, branches, PRs, and Slack threads. Every artifact uses one campaign prefix.
- Do not target customer repositories or channels. Repository writes are limited to disposable test repositories and disposable branches.
- Default to read-only MCP scopes. Grant `runs:dispatch`, `workflows:write`, `prompts:write`, or `tickets:write` only to the lane that needs it.
- Do not edit built-in prompts. Prompt mutation tests use a campaign-owned prompt and restore or archive it during cleanup.
- Do not publish an enabled workflow until its triggers, allowlist, budget, and cleanup behavior have passed preflight.
- Do not combine discovery and repair. A failing wave freezes its inputs, records evidence, and stops. A separate fix wave changes code; the original scenario is then replayed unchanged.
- Stop the campaign immediately on evidence of cross-tenant access, uncontrolled external writes, duplicate PR creation, runaway dispatch, budget breach, leaked credentials, or a run that cannot be cancelled.

## Campaign identity and evidence

Use one immutable campaign ID such as `STRESS-20260813-A`. Every created object includes it:

```text
ticket summary: [STRESS-20260813-A][lane-03][case-HITL-02]
workflow name: stress-20260813-a-lane-03-hitl
idempotency key prefix: stress-20260813-a-l03-
branch: stress/20260813-a/lane-03/case-hitl-02
Slack thread header: STRESS-20260813-A / lane-03
```

For every case record:

- case ID and agent lane;
- start/end timestamps in UTC;
- deployed commit and MCP contract hash;
- workflow definition ID, deployed version, graph hash, and trigger node ID;
- ticket key, run ID, claim/attempt IDs where exposed, repository, branch, and PR/MR;
- exact MCP tool sequence with secrets and bodies redacted;
- expected state transitions and observed state transitions;
- Jira, Slack, dashboard/API, MCP, and provider outcomes;
- duration, token usage, model attribution, cost, retry count, and terminal reason;
- cleanup state;
- verdict: `PASS`, `FAIL`, `BLOCKED`, or `NOT RUN`.

No case is marked `PASS` from prose alone. It requires MCP/API evidence and a terminal state.

## Agent topology

The coordinator owns environment selection, credentials, naming, dispatch order, global stop conditions, deduplication, Jira creation, and final acceptance. Test agents do not merge fixes and do not alter another lane's fixtures.

| Lane | Responsibility | Required MCP scopes | Exclusive write ownership |
| --- | --- | --- | --- |
| 0 — Contract sentinel | Auth, discovery, contract hash, error envelopes, readiness before and after every wave | `mcp:read` | None |
| 1 — Authoring | Workflow and prompt create/save/publish conflicts, graph hashes, disabled/live trigger semantics | `mcp:read`, `workflows:write`, narrowly `prompts:write` | Campaign-owned definitions and prompt |
| 2 — Run lifecycle | Preflight, dispatch, result, trace, diagnose, cancellation, idempotency | `mcp:read`, `runs:dispatch` | Manual-dispatch workflows and run keys |
| 3 — Human input | Awaiting input, clarification reads/answers, duplicate answers, Jira synchronization | `mcp:read`, `runs:dispatch` | HITL workflows and tickets |
| 4 — Ticket operations | Ticket creation, comments, transitions, duplicate comment suppression, Jira-triggered dispatch | `mcp:read`, `tickets:write` | Dedicated Jira component/labels and tickets |
| 5 — Investigation | Jira/Slack investigate blocks and Zendesk/Sentry-style workflow outcomes | `mcp:read`, `runs:dispatch` | Investigation fixtures and evidence threads |
| 6 — Trigger matrix | Schedule, authenticated webhook, PR/MR, checks, review, merge, deduplication | `mcp:read`, `workflows:write` | Dedicated schedules, webhook endpoints, repo branches |
| 7 — Reliability/load | Rate limits, concurrency, claim ownership, retries, cancellation races, soak | `mcp:read`, `runs:dispatch` | Load workflows, idempotency namespace, concurrency quota |
| 8 — Observability auditor | Cross-surface state, model, cost, reason, redaction, audit log, freshness | `mcp:read` | Evidence report only |
| 9 — Cleanup auditor | Disable/archive workflows, settle test tickets, close PRs, verify no active runs or schedules | Minimum scopes needed per artifact | Cleanup ledger |

Agents are started by wave, not all at once. Lanes that write workflows, tickets, or repositories receive disjoint namespaces. The contract sentinel and observability auditor may run concurrently because they are read-only.

## Wave 0 — Baseline and negative auth

1. Confirm the canonical endpoint resolves to the intended source commit.
2. Run anonymous initialize and prove `401` plus the expected `WWW-Authenticate` challenge.
3. Complete fresh DCR, consent, PKCE, and authenticated initialize without printing a token.
4. Compare all 22 names, order, descriptions, annotations, input schemas, 11 error codes, and contract hash.
5. Call every tool with an invented argument and require a declared structured refusal.
6. Verify each scope boundary with a token missing exactly one required scope.
7. Verify expired, malformed, wrong-audience, and revoked credentials fail closed.
8. Capture system capabilities, limits, enabled domains, deployment version, and announcement configuration.

Exit: no mutation has run; the contract sentinel reports a clean baseline.

## Wave 1 — Read surface and historical diagnosis

Cases:

- existing ticket with zero, one, and many runs;
- existing successful, failed, blocked, cancelled, awaiting-input, and running run;
- `runs.get`, `runs.trace`, `runs.result`, and `runs.diagnose` agree on identity and terminal state;
- pagination and boundary limits for comments, runs, trace events, and result payloads;
- unknown ticket/run/definition returns `NOT_FOUND`, not an internal error;
- untrusted ticket, Jira, Slack, and agent-authored text is returned as data and never followed as instruction;
- redaction preserves IDs while removing secrets and PII;
- AIW-249 and AIW-271 historical shapes no longer appear as active phantom/orphan rows.

Exit: every historical state is readable and internally consistent.

## Wave 2 — Authoring and optimistic concurrency

Create a disabled campaign workflow and prove:

- create returns a stable definition ID and initial revisions;
- saving the same valid draft is deterministic;
- stale `expectedDraftRevision` is rejected with `CONFLICT` and stores nothing;
- malformed graphs, unknown blocks, invalid bindings, cycles, unbounded loops, and missing required trigger inputs are rejected;
- layout-only changes do not change semantic draft revision;
- publish requires exact draft and deployed versions;
- stale publish attempts cannot replace the live head;
- graph hash matches the canonical graph that was published;
- disabled definitions remain dormant after publish;
- enabled definitions accurately report `liveOnRealEvents` and dormant trigger nodes;
- repository pins outside the normal allowlist are reported exactly as designed;
- campaign prompt update creates one version, returns a body hash, rejects stale versions, and never echoes the prompt body;
- built-in prompt mutation is refused with `FORBIDDEN`;
- authoring audit rows and operator announcements contain metadata but no secret bodies.

Exit: one known-good disabled definition is available to later waves; prompt fixture is restored.

## Wave 3 — Single real-run lifecycle

Run one case at a time before adding load:

1. preflight a valid manual dispatch;
2. dispatch with a unique idempotency key;
3. immediately repeat the same request and require the same logical run, not a duplicate;
4. reuse the key with different input and require `IDEMPOTENCY_CONFLICT`;
5. observe queued/running state, trace growth, final result, tokens, model, cost, duration, and terminal reason;
6. verify Jira, Slack, MCP, dashboard/API, and repository state agree;
7. dispatch a deterministic no-change task and verify the documented terminal result;
8. dispatch a controlled failure and verify the underlying cause survives every surface;
9. cancel a running case and verify the block and run settle once with no later publication;
10. cancel an already terminal case and verify idempotent behavior.

Exit: happy, no-change, failure, and cancellation paths are proven on real runs.

## Wave 4 — Human input and Jira synchronization

Cases:

- an intentionally underspecified ticket reaches Awaiting input;
- `runs.get_clarification` returns questions, suggestions, ID, and `answerable: true`;
- answering through MCP resumes exactly the waiting node and does not restart the workflow;
- Jira returns to the expected AI processing status when the run resumes;
- answering through the dashboard path and through a Jira human comment follows the documented ownership rules;
- a bot-authored Jira comment never answers its own clarification;
- a duplicate answer is idempotent or returns a declared conflict;
- two simultaneous answers produce one successor claim;
- moving the ticket out of AI while waiting settles the run correctly;
- moving it out while running cannot leave a permanent RUNNING row;
- moving an active ticket from AI to AI Review before any PR is published cannot manufacture a Success outcome;
- moving a ticket to AI Review after confirmed PR publication while the run is only finalizing preserves the genuine Success outcome;
- the AIW-275 product rule for moving a ticket directly from AI Backlog to AI Review with no associated run remains unsettled; after the decision, verify that the transition follows the chosen policy and is idempotent under webhook replay;
- two identical tickets may make different model decisions, but both decisions are explainable from recorded context and neither bypasses required clarification.

Exit: no Awaiting input case is stranded and Jira/MCP state agrees.

## Wave 5 — Jira, Slack, Zendesk, and Sentry investigation

Build real but disposable evidence sets:

- Jira issue with rich description, comments, links, labels, and a missing optional field;
- Slack thread with relevant messages, irrelevant messages, replies, mentions, and intentionally adversarial text;
- Zendesk-style support payload for a real code defect;
- Zendesk-style non-code request;
- Sentry-style error with matching code evidence;
- Sentry-style false positive or insufficient evidence;
- cross-provider case where Jira and Slack disagree;
- empty search result, permission refusal, rate limit, and temporary dependency failure.

For each case verify bounded retrieval, tenant scoping, source attribution, evidence gaps, classification, recommendation, human-approval boundary, and that no unsupported fact is invented. A code defect may produce a disposable PR; a non-code or insufficient-evidence case must not.

Exit: AIW-257 and AIW-261 have real-run evidence for positive, negative, ambiguous, and dependency-failure outcomes.

## Wave 6 — Trigger matrix

Exercise each trigger independently before combinations:

- Jira ticket moved into AI;
- manual MCP dispatch;
- authenticated generic webhook with valid, invalid, revoked, and replayed credentials;
- schedule in UTC and a non-UTC timezone;
- overlapping schedule with skip/queue policy;
- PR/MR created or ready-for-review;
- PR/MR updated to a new head;
- checks failed;
- review submitted;
- PR/MR merged;
- resolved ticket no-op;
- self-authored bot event recursion suppression.

Every trigger must prove durable delivery, deduplication, a matching `workflow_runs` row before start publication, exact deployed-version pinning, correct subject/claim ownership, and one terminal outcome. Replayed webhooks and duplicate provider deliveries must not create duplicate runs or comments.

Exit: every supported trigger has one positive and one refusal/deduplication result.

## Wave 7 — Rate limits, concurrency, and backpressure

Increase pressure gradually and stop at the configured limits:

| Profile | Input | Expected proof |
| --- | --- | --- |
| Serial | 10 sequential runs | Stable baseline and no resource leakage |
| Small burst | 5 simultaneous dispatches | All accepted within capacity or explicitly refused |
| Capacity edge | Exactly configured concurrent-run limit | No oversubscription and truthful queue state |
| Over capacity | Limit plus 1, then plus 5 | Structured `RATE_LIMITED`/capacity refusal and retry guidance |
| Same subject | 5 dispatch attempts for one ticket/PR | One active claim and deterministic duplicates |
| Same idempotency key | 20 concurrent identical calls | One logical effect |
| Mixed triggers | Jira, webhook, schedule, and MCP at once | Shared pool remains bounded and fair |
| Cancellation storm | Cancel half of active runs | Capacity is released and no cancelled run publishes |
| Soak | Low steady traffic for two hours | No orphan claims, memory growth, stale UI, or accumulating retries |

Track acceptance/refusal latency, queue delay, run duration, retries, tokens, cost, and terminal distribution. A refusal is a pass when it is structured, expected, and effect-free.

Exit: no phantom starts, duplicate effects, permanent rows, or unexplained capacity loss.

## Wave 8 — Recovery and failure injection

Use reversible, scoped faults only:

- unavailable Jira or Slack adapter;
- provider 401/403/404/409/429/5xx;
- sandbox startup failure;
- repository unavailable or removed from allowlist;
- branch/head changes between preflight and execution;
- publication timeout where the effect may already exist;
- agent timeout and budget exhaustion;
- process interruption after durable acceptance but before result publication;
- lost active claim for a running row;
- missing run row during schedule, webhook, and PR start publication;
- deployment change while a run is pinned to an older version;
- stale clarification checkpoint and expired snapshot.

Verify retryability, `effectNotApplied`, idempotency-key return rules, exact terminal reason, backstop behavior, and absence of duplicate external effects. Fault removal must allow a clean new run without hand-editing database state.

Exit: every injected fault is terminal, retryable, or operator-actionable by contract.

## Wave 9 — Cross-surface observability audit

The read-only auditor samples every case and verifies:

- run and block status agree across MCP, dashboard/API, Jira, Slack, and provider;
- active views refresh while terminal views stop polling appropriately;
- model attribution names the actual model used, not an organization fallback;
- duration excludes human wait where specified;
- token and cost values are present when measurable and explicitly unavailable otherwise;
- failure reason preserves the provider/infrastructure cause without leaking secrets;
- cancelled, failed, blocked, awaiting, and successful outcomes are never relabeled;
- audit records identify actor, tool, effect, hash, and timestamp;
- logs and notifications use the same ticket, run, workflow, repository, and PR identity;
- redaction does not corrupt UUIDs, hashes, URLs, or ticket keys;
- no live panel retains a terminal run after the documented consistency window.

Exit: each status family has at least one cross-surface evidence bundle.

## Wave 10 — Cleanup and leak audit

Cleanup is part of the test, not an informal afterthought:

1. stop dispatch;
2. wait for accepted runs to settle or cancel them through the supported path;
3. disable/archive campaign workflows and schedules;
4. revoke campaign webhook secrets and OAuth clients/tokens;
5. restore or archive the campaign prompt;
6. transition/close test tickets and add one cleanup comment;
7. close disposable PRs/MRs and delete only campaign branches;
8. verify no active claims, RUNNING/AWAITING rows, queued occurrences, unprocessed deliveries, or retry loops remain;
9. verify no campaign workflow can react to future real events;
10. publish the cleanup ledger with every artifact marked removed, retained with reason, or handed to an owner.

Exit: zero unowned live artifact and zero unexplained non-terminal run.

## Defect workflow

When a case fails:

1. stop dependent cases and freeze the deployment commit;
2. reproduce once with the same definition/version and inputs;
3. compare against existing Jira defects and previous stress findings;
4. create one Jira issue only if it is new, with severity, exact timestamps, IDs, expected/actual behavior, redacted MCP sequence, and smallest reproduction;
5. assign the issue to the campaign owner and link the failed case;
6. let a separate implementation agent produce a narrow fix and regression test;
7. obtain review, merge, deploy, and rerun the original case unchanged;
8. rerun adjacent cases when the fix changes a shared trigger, claim, auth, authoring, or publication boundary;
9. close the finding only when the original real-run case passes and cleanup succeeds.

Severity guide:

- `P0`: cross-tenant access, credential leak, uncontrolled write/deploy, runaway cost, or uncancellable runaway execution;
- `P1`: duplicate external effect, lost run, permanent RUNNING/AWAITING row, wrong repository, false success, or broken primary trigger;
- `P2`: actionable failure obscured, inconsistent status, bounded retry/limit defect, or one workflow class blocked;
- `P3`: stale presentation, cosmetic redaction, wording, or low-impact operator friction.

## Final acceptance report

The campaign is complete only when the report contains:

- exact deployed commit and MCP contract hash;
- matrix totals for passed, failed, blocked, and not-run cases;
- per-lane evidence links and cleanup state;
- load profile measurements and configured limits;
- list of discovered Jira defects with severity and retest status;
- confirmation that no P0/P1 remains open;
- confirmation that no orphan run, claim, delivery, schedule, OAuth client, ticket, branch, or PR remains unowned;
- explicit statement that Arthur was not changed;
- a recommendation: `ready for Arthur release-candidate preparation`, `fix and rerun`, or `stop`.

This recommendation does not deploy Arthur. It only supplies evidence for the separate release decision.
