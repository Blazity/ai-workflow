# Arthur Engine Scope and EVALS Status

**Jira:** [AIW-255](https://blazity.atlassian.net/browse/AIW-255), Prepare report on Arthur Engine scope, PromptRange, and EVALS
**Date:** 2026-08-12
**Code revision for every `file:line` citation below:** `533b514f`
**Companion document:** [Workflow Guardrails](./2026-08-12-workflow-guardrails.md), owned by [AIW-263](https://blazity.atlassian.net/browse/AIW-263), which covers the enforcement model, the guardrails matrix, and the [AIW-258](https://blazity.atlassian.net/browse/AIW-258) brief.

This document answers one question: **where does AI Workflow end and the Arthur Engine begin, and what of that is actually working today.**

## How to read this document

| Marker | Meaning |
| --- | --- |
| **Implemented** | Verified in the codebase at `533b514f`, with a `file:line` reference. |
| **Implemented, in verification** | Code is merged; a Jira ticket is open to prove it works in the deployed environment. |
| **In progress** | Actively being worked. |
| **Planned** | Specified in Jira, not started. |
| **Unknown** | No supporting evidence was found. Stated as unknown rather than assumed. |

A claim marked **Unknown** must not be presented to a client as a capability.

---

## 1. Executive summary

1. **The Arthur Engine is an observability and evaluation system, not an enforcement system.** It observes and scores what an agent did. It cannot stop an agent from doing it. This is confirmed both by our integration code and by Arthur directly, and it is the single most important fact for any guardrails conversation.
2. **The integration surface is small, optional, and observability-shaped.** Two optional environment variables switch it on. With them unset, every Arthur code path degrades to a skip and the product runs normally.
3. **Prompt ownership already left the Arthur Engine.** [AIW-114](https://blazity.atlassian.net/browse/AIW-114) moved agent prompt templates into our own shared contracts package and prompt library. What remains on Arthur's side is tracing, prompt-injection screening, and evaluation.
4. **PromptRange is undefined and unowned.** No integration or ownership is evidenced anywhere in the codebase, and Jira contains only AIW-255 itself. Until an owner documents it, it is external to AI Workflow and must not appear in client-facing material as a capability, an integration, or a roadmap item.
5. **The EVALS stage is wired but unproven in operation.** Producer and consumer code both exist and both degrade honestly, but no evidence was found that continuous evaluations are currently configured and grading fresh traces. [AIW-75](https://blazity.atlassian.net/browse/AIW-75) exists precisely to settle this and is still open.

---

## 2. What AI Workflow owns

| Capability | Status | Evidence |
| --- | --- | --- |
| Workflow definition, versioning, deployment, and validation | Implemented | `apps/worker/src/workflow-definition/` |
| Agent execution in an isolated sandbox, for both Claude and Codex runtimes | Implemented | `apps/worker/src/sandbox/agents/claude.ts`, `apps/worker/src/sandbox/agents/codex.ts` |
| Repository selection, checkout, per-repository read/write access, and publication | Implemented | `apps/worker/src/sandbox/repo-workspace.ts`, `apps/worker/src/sandbox/trusted-workspace-publisher.ts` |
| Agent prompt ownership and the prompt library | Implemented | [AIW-114](https://blazity.atlassian.net/browse/AIW-114) (Done) |
| Harness Profiles: pinned CLI, model, instructions, skills, limits | Implemented | `apps/worker/src/harness-profiles/manifest.ts` |
| Human-in-the-loop: clarification and plan approval | Implemented | `apps/worker/src/workflows/blocks/human-question.ts`, `apps/worker/src/workflows/blocks/send-plan-approval.ts` |
| Run observability, replay capture, and the dashboard | Implemented | `apps/worker/src/run-observability/` |
| Deployment-owned skills read from the deployment's own repository | Implemented, in verification | [AIW-246](https://blazity.atlassian.net/browse/AIW-246), merged via PR #241, Jira in Weryfikacja; `apps/worker/src/harness-profiles/local-skills.ts` |
| Arthur private repository-aware post-PR review workflow | Implemented, in verification | [AIW-221](https://blazity.atlassian.net/browse/AIW-221) |
| MCP endpoint for authoring and inspecting workflows | In progress | [AIW-239](https://blazity.atlassian.net/browse/AIW-239) |

**Everything that decides what happens, and everything that enforces a boundary, is on this side of the line.**

---

## 3. What remains in the Arthur Engine

The integration is enabled by two environment variables that are optional and only meaningful together: `GENAI_ENGINE_API_KEY` and `GENAI_ENGINE_TRACE_ENDPOINT` (`apps/worker/env.ts:94` and `:95`).

| Arthur capability we use | Status | Evidence |
| --- | --- | --- |
| Per-ticket task creation, so each run gets its own observability bucket | Implemented | `apps/worker/src/sandbox/arthur-client.ts` (`ensureTaskForTicket`) |
| Trace ingestion from inside the sandbox, via a tracer installed as CLI hooks | Implemented | `apps/worker/src/sandbox/agents/claude.ts:533` writes the tracer to `~/.claude/hooks/` |
| Prompt-injection screening through `validate_prompt` | Implemented, report-only | `apps/worker/src/workflows/blocks/arthur-injection-check.ts:39` |
| Cost and token aggregation from trace rows | Implemented | `apps/worker/src/sandbox/arthur-client.ts` (`listTraces`) |
| Continuous evaluation aggregation into a fleet eval score | Implemented, unproven in operation | `apps/worker/src/lib/overview/collect-evals.ts`, see section 6 |

Two structural facts define the boundary precisely:

- **The tracer is Arthur's code, not ours.** It is generated at build time from a sibling `arthur-engine` checkout (`apps/worker/scripts/build-arthur-tracer.mjs:10` to `:19`) and base64-bundled into our deployment. That checkout is not part of this repository. The build script fails loudly when it is missing, so the dependency is explicit rather than silent.
- **The Arthur hooks we install are the observability hook set**, including `PreToolUse` (`apps/worker/src/sandbox/agents/claude.ts:31` to `:37`). The hook points exist and are already occupied by tracing. They currently carry no enforcement.

### The prompt-injection check is report-only

This is worth stating on its own, because it is the Arthur feature most likely to be mistaken for a guardrail. The block returns `ok`, `flagged`, or `skipped` as an ordinary branchable output (`apps/worker/src/workflows/blocks/arthur-injection-check.ts:39`). **It never blocks a run.** A workflow author may branch on `flagged`, but nothing requires them to. Arthur describes the underlying classifiers as roughly 90 percent accurate and explicitly not perfect, which is a further reason not to build a hard block on top of them.

---

## 4. What the Arthur Engine explicitly is not

This was established directly with Arthur in an engineering Q&A recorded in `#ai-workflow` on 2026-05-07 ([Slack thread](https://blazity.slack.com/archives/C0AKTDHG2CF/p1778140849942379)). The relevant statements, as recorded:

- The Arthur Engine **is not an agent runtime, is not middleware, is not an in-loop execution controller, and is not a request blocker.**
- The architecture is: the agent acts, telemetry is emitted, the engine processes traces asynchronously, and evaluations analyze the interaction afterwards. Therefore **the engine cannot prevent a request from being executed**; it can only evaluate and report on it.
- A synchronous evaluation API does exist, returning a score, an explanation, and a cost. Used that way an evaluation can act as a runtime guardrail, **but only if the calling application explicitly blocks on it before proceeding.** The enforcement decision stays with the caller, which is us.
- A domain denylist inside the Arthur Engine does **not** exist. A design in which the engine maintains a blacklist and agents query it before acting, with enforcement client-side, was raised as a possibility and described as **not implemented and not on the roadmap**.
- Guardrail management is a **closed-source Arthur Platform** feature. The open-source engine and its UI do not expose guardrail management.

**Consequence.** Any hard block we promise must be built and enforced by AI Workflow. Arthur can tell us that something happened and can score how bad it was. It cannot be the thing that stops it. This is not a limitation discovered late; it is the vendor's own description of the product's role. How we enforce instead is the subject of the [companion guardrails document](./2026-08-12-workflow-guardrails.md).

---

## 5. PromptRange

**Status: undefined and external, pending an owner.**

Searches performed for this report:

| Search | Result |
| --- | --- |
| Full repository, case-insensitive, all file types | Zero matches |
| Jira project AIW, full-text | One match, AIW-255 itself |

**The defensible claim is narrow and should be stated exactly this way:** no integration, dependency, or ownership is evidenced in the codebase, and Jira contains no definition of it beyond the ticket that asks for this report. This document does not claim the topic has never been raised. It claims that nothing in code or Jira defines what PromptRange is, who owns it, or how it would relate to this product.

Until that changes, PromptRange is **external to AI Workflow**, and it must not be described to a client as core, as optional-but-supported, or as planned. The open question is recorded in section 8.

---

## 6. EVALS status

**Status: implemented as code, unproven as an operating capability.**

The full producer-to-consumer path exists:

- Traces are produced by the in-sandbox tracer.
- Aggregation counts traces by `continuous_eval_run_status` and derives a pass rate over graded traces (`apps/worker/src/lib/overview/collect-evals.ts`).
- The API surfaces the result and degrades honestly in three distinct ways rather than fabricating a score: Arthur unconfigured, no graded evals in the window (`apps/worker/src/routes/api/v1/evals.get.ts:44`), and upstream failure (`:61`, which reads "Eval grading not wired up yet.").

**The code is careful. That is not the same as the feature working.** What is not established, and is exactly why [AIW-75](https://blazity.atlassian.net/browse/AIW-75) is still open:

- Whether continuous evaluations are currently configured on the Arthur tenant at all.
- Whether they are grading fresh traces produced by our runs.
- Whether the dashboard is showing fresh data rather than an empty state.

AIW-75 is scoped as a live producer-to-consumer verification ending in a keep-or-remove decision, and it explicitly carries the rule that evals must not be removed merely because prompt ownership moved ([AIW-114](https://blazity.atlassian.net/browse/AIW-114)).

Note that **prompt-injection screening is independent of evaluation grading.** It calls `validate_prompt` directly and does not require continuous evals to be configured. The two must not be described as one capability.

---

## 7. Client and demo wording

### Positioning, before any capability claim

AI Workflow is designed to work **alongside** a client's existing agent and tagging setup, not to replace it. During a client testing window the goal is to surface edge cases and prove stability, not to demonstrate feature breadth.

### Safe to say

- Every workflow run is traced, and each ticket gets its own observability bucket in the Arthur Engine.
- Prompt-injection screening runs against ticket content and reports its findings into the run, where a workflow can branch on them.
- Agent prompts are owned and versioned by AI Workflow itself, in its own prompt library.
- Cost and token usage per run are collected and visible.

### Say with the qualifier attached

- Evaluation scoring: **the plumbing exists and is being verified end to end.** Do not present an eval score as a live, trusted number until [AIW-75](https://blazity.atlassian.net/browse/AIW-75) closes.
- Prompt-injection screening: **it reports, it does not block.** Presenting it as a guardrail would be inaccurate.

### Do not say

- That the Arthur Engine blocks, prevents, or gates anything. It does not, by its own design.
- That PromptRange is part of the product, supported, or planned.
- That evaluations are currently grading production traces, until that is verified.

### The one paragraph to say out loud

> The Arthur Engine is our observability and evaluation layer. Every run is traced, every ticket gets its own bucket, and prompt-injection screening runs over incoming content and reports what it finds. What the engine deliberately does not do, by its own architecture, is sit in the execution path and block an action. That is our job, and it is enforced in the platform itself. Evaluation scoring is wired end to end and we are verifying the grading configuration before we put a number in front of you.

---

## 8. Open ownership questions

1. **Who owns PromptRange?** Nothing in code or Jira defines it. It needs either a definition and an owner, or an explicit decision to drop it, before the client demo.
2. **Will [AIW-75](https://blazity.atlassian.net/browse/AIW-75) close before the demo?** If not, the evals surface must be described as being verified, not as live.
3. **Who operates the Arthur tenant configuration** for continuous evals, and where is that documented? AIW-75 lists this as part of its scope and it is not yet answered.
4. **Where should `docs/plans/2026-07-31-arthur-workflow-decisions.md` live?** Both [AIW-75](https://blazity.atlassian.net/browse/AIW-75) and [AIW-221](https://blazity.atlassian.net/browse/AIW-221) cite it as their written decision record, and it is not present in this repository's history.
5. **Roadmap linkage.** This report is linked from `docs/AI-WORKFLOW-ROADMAP.md`, and its capability and release-gate language is kept consistent with that roadmap.

---

## 9. Evidence inventory

| Source | Use |
| --- | --- |
| Codebase at `533b514f` | Every implementation claim, cited as `file:line` |
| Jira AIW project | Scope and status for AIW-75, AIW-114, AIW-221, AIW-239, AIW-246, AIW-250, AIW-255 |
| Slack `#ai-workflow`, 2026-05-06 and 2026-05-07 | The Arthur Engine capability boundary, recorded directly from the vendor |
| `docs/AI-WORKFLOW-ROADMAP.md` | Consistency check for phase and status language |

### Related Jira work

| Ticket | Status | Relevance |
| --- | --- | --- |
| [AIW-75](https://blazity.atlassian.net/browse/AIW-75) | Verification | Verify Arthur evals and observability end to end; keep-or-remove decision |
| [AIW-114](https://blazity.atlassian.net/browse/AIW-114) | Done | Prompt ownership moved out of the Arthur Engine; defines today's boundary |
| [AIW-221](https://blazity.atlassian.net/browse/AIW-221) | Verification | Arthur private repository-aware post-PR review |
| [AIW-239](https://blazity.atlassian.net/browse/AIW-239) | In progress | MCP endpoint for authoring and inspecting workflows |
| [AIW-246](https://blazity.atlassian.net/browse/AIW-246) | Verification | Deployment-owned skills, merged via PR #241 |
| [AIW-250](https://blazity.atlassian.net/browse/AIW-250) | To do | Arthur release preflight; the tenant runs behind main |
| [AIW-255](https://blazity.atlassian.net/browse/AIW-255) | Verification | This document, merged via PR #248 |
| [AIW-263](https://blazity.atlassian.net/browse/AIW-263) | Verification | The companion guardrails design document; blocks AIW-258 |
| [AIW-258](https://blazity.atlassian.net/browse/AIW-258) | Planned | Guardrail enforcement. Blocked by AIW-263, and deliberately not part of the current integration pass |
