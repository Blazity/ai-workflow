# Workflow Guardrails: Enforcement Model, Matrix, and Implementation Brief

**Jira:** [AIW-263](https://blazity.atlassian.net/browse/AIW-263), Prepare enforceable workflow guardrails design document. Blocks [AIW-258](https://blazity.atlassian.net/browse/AIW-258).
**Date:** 2026-08-12
**Code revision for every `file:line` citation below:** `533b514f`
**Companion document:** [Arthur Engine Scope and EVALS Status](./2026-08-12-arthur-engine-scope-and-evals.md), owned by [AIW-255](https://blazity.atlassian.net/browse/AIW-255), which covers the product boundary, PromptRange, and evaluation status.

This document answers one question: **what does AI Workflow actually prevent an agent from doing, and what would it take to prevent the rest.**

## How to read this document

| Marker | Meaning |
| --- | --- |
| **Implemented** | Verified in the codebase at `533b514f`, with a `file:line` reference. |
| **Implemented, in verification** | Code is merged; a Jira ticket is open to prove it in the deployed environment. |
| **In progress** | Actively being implemented right now. |
| **Planned** | Specified in Jira, not started, and outside the current integration pass. |
| **Proposed** | Recommended here. No ticket-level design exists yet. |
| **Unknown** | No supporting evidence was found. Stated as unknown rather than assumed. |

A claim marked **Unknown** must not be presented to a client as a capability.

## Arthur's role, in one paragraph

The Arthur Engine observes and evaluates; it does not enforce. It is not an in-loop execution controller and cannot prevent a request from being executed, and its prompt-injection screening in this product is report-only (`apps/worker/src/workflows/blocks/arthur-injection-check.ts:39`). **Every hard block described in this document is therefore built and enforced by AI Workflow itself.** The evidence for that boundary is in the [companion document](./2026-08-12-arthur-engine-scope-and-evals.md) and is not repeated here.

---

## 1. Executive summary

1. **AI Workflow already enforces meaningful, deterministic guardrails**, but they are repository-scoped and publication-scoped, not path-scoped.
2. **The strongest control is architectural rather than configured.** The agent sandbox holds no version-control credential at all, so the agent cannot publish anything and cannot call the provider API. All publication is performed by the worker, outside the agent's reach.
3. **The gap is path-level and action-level policy:** which files may be read, which may be edited, and which changes require a named human approval before a pull request exists. None of that exists today.
4. **Anything running inside the sandbox is advisory, by construction.** The codebase already says so, and this document adopts that as its central design rule.
5. **Audit is the weakest dimension.** The run contract carries a `guardrailHits` field that no code path has ever populated.
6. **Runaway execution is a guardrail concern too**, tracked separately as [AIW-256](https://blazity.atlassian.net/browse/AIW-256) (In progress) and [AIW-241](https://blazity.atlassian.net/browse/AIW-241). It should stay out of [AIW-258](https://blazity.atlassian.net/browse/AIW-258)'s scope so neither blocks the other.

---

## 2. Where enforcement actually happens

Guardrails live at five layers. The distinction between them is the difference between a promise and a guarantee.

### L0. Sandbox isolation (the containment boundary)

Every agent runs inside a Vercel Sandbox microVM. Inside that microVM, both provider CLIs run with their own approval gates switched off:

- Claude: `--dangerously-skip-permissions` (`apps/worker/src/sandbox/agents/claude.ts:207`).
- Codex: `approval_policy = "never"` and `sandbox_mode = "danger-full-access"` (`apps/worker/src/sandbox/agents/codex.ts:120` and `:121`), invoked with `--dangerously-bypass-approvals-and-sandbox` (`:218`).

This is deliberate and documented in the code. Codex's own workspace-write sandbox shells out to `bwrap`, which requires user-namespace creation that the Vercel Sandbox microVM blocks. Isolation was therefore moved outward to the microVM rather than layered twice.

**How to describe this:** isolation is enforced by the microVM boundary, not by a CLI prompt. The agent is confined to a disposable machine. It is not confined *within* that machine, which is exactly why L1 and L2 matter.

### L1. Credential scope (the strongest control we have)

**The agent's environment contains no version-control credential.** What is written into the sandbox for the agent is the model-provider credential and, when Arthur is configured, the tracer's endpoint and task identifiers (`apps/worker/src/sandbox/agents/claude.ts:79` onward, `apps/worker/src/sandbox/agents/codex.ts:87` to `:103`).

Version-control tokens are supplied per command by the worker as a one-shot header argument (`apps/worker/src/lib/vcs-urls.ts:17`) rather than being written into a remote URL or a credential helper, so nothing push-capable is left behind in the checkout.

Two hard blocks follow for free:

- **The agent cannot push, open, close, or modify anything on the remote.** Publication is performed by the worker.
- **The agent cannot call the version-control provider's API at all**, so it cannot change repository permissions, collaborator lists, branch protection, or any other access configuration. There is no credential with which to attempt it.

### L2. Worker-side gates (deterministic, outside the agent's reach)

These run in worker code the agent cannot execute, read, or modify.

| Gate | What it enforces | Evidence |
| --- | --- | --- |
| Repository allowlist | An operator-configured set of repositories the agent may ever touch | `apps/worker/src/lib/repo-allowlist.ts:70` |
| Workflow repository pin | A deployed workflow may extend the allowlist only by pinning an exact provider and path; a provider-only scope can only narrow | `apps/worker/src/lib/repo-allowlist.ts:94` |
| Per-repository access mode | Each repository in a workspace is `read` or `write` | `apps/worker/src/sandbox/repo-workspace.ts:157` |
| Read-only restoration | Before any fix result is inspected or published, every read-only repository is hard-reset to its research baseline and the restoration is verified | `apps/worker/src/workflows/blocks/fix-workspace-state.ts:79` |
| Publication preflight | A read-only repository that changed fails publication with `read_only_changed` | `apps/worker/src/sandbox/trusted-workspace-publisher.ts:26` |
| Manifest integrity | The sandbox copy of the workspace manifest must byte-match the manifest the worker authored, so an agent editing it changes nothing | `apps/worker/src/sandbox/repo-workspace.ts:173` |
| Path integrity | A repository's local path must equal its identity-derived slug path, rejecting traversal, nesting, and cross-repository aliasing without a filesystem probe | `apps/worker/src/sandbox/repo-workspace.ts:106` |
| Source pull-request identity | Remediation publication requires the source pull request to still be open, at the same head, against the same target | `apps/worker/src/workflows/source-pull-request.ts:12` |
| Approved-scope recheck | Every approved repository is rechecked at provisioning; drift in default branch, research head, availability, archive state, or pin coverage forces a replan rather than a silent narrowing | `apps/worker/src/workflows/blocks/prepare-workspace.ts:114` |
| Lease-based push | Publication uses exact target heads and force-with-lease, so a replay is safe and a concurrent remote change is rejected | `apps/worker/src/sandbox/trusted-workspace-publisher.ts` |
| Profile limits | Duration, token, and cost ceilings from the Harness Profile are combined with workflow limits by taking the minimum | `apps/worker/src/sandbox/harness-runtime-limits.ts:14` |

**One known weakness, stated plainly.** The repository allowlist **fails open**: when `AGENT_ALLOWED_REPOS` is empty, every installed repository is permitted. The code makes this loud rather than silent, warning that "the agent may branch/PR on ANY installed repo" (`apps/worker/src/lib/repo-allowlist.ts:61`), and a malformed entry is dropped individually so one typo cannot widen the list to "all" as long as one valid entry remains. For a client deployment this should be treated as required configuration, not optional hardening.

### L3. In-sandbox hooks (defense in depth, bypassable by construction)

Two guards run inside the sandbox: a pre-commit hook that refuses to commit platform-managed memory paths, and a Stop-hook commit guard.

The codebase already states the correct doctrine, and this document adopts it as its central design rule. From `apps/worker/src/sandbox/git-excludes.ts:69`:

> The authoritative guard is therefore the publication gate in `trusted-workspace-publisher.ts`, which the agent cannot reach.

The same comment enumerates the known ways around the in-sandbox hook: `git commit --no-verify`, a repository-owned `core.hooksPath`, a hook overwritten by a package install, and plain deletion of the file. This generalizes: **anything that runs inside the sandbox is advisory, because the agent has write access to the sandbox.**

### L4. Report-only and guidance (never a block)

| Mechanism | Behavior |
| --- | --- |
| Arthur prompt-injection check | Returns `ok`, `flagged`, or `skipped` as a normal branchable output. It never blocks (`apps/worker/src/workflows/blocks/arthur-injection-check.ts:39`) |
| Leak review | Scans a diff for configured secrets before publication, behind the `ENABLE_LEAK_REVIEW` flag (`apps/worker/src/workflows/blocks/leak-review.ts`) |
| Review skills and instructions | Raise scrutiny in the model's reasoning. They express what deserves attention, not what is permitted |

**This is the line AIW-255 asked us to draw.** L1 and L2 prevent an action. L3 discourages it. L4 comments on it afterwards. **Only L1 and L2 may be described to a client as guardrails.**

### Human-in-the-loop, as built today

- **Clarification.** A block returns `needs_human_input`, and the engine posts the questions, labels the ticket, moves it back, and notifies (`apps/worker/src/workflows/blocks/human-question.ts`). The run parks; a human answer resumes it. A parked run is visible as awaiting input rather than looking stalled.
- **Plan approval with a bound scope.** Before implementation, the run creates an approval request carrying the plan, the assumptions, and an `ApprovedRepositoryScope` (`apps/worker/src/workflows/blocks/send-plan-approval.ts:17` and `:34`), persisted in `apps/worker/src/db/approvals-schema.ts`. The approved scope names each repository, its access mode, and the exact 40-character baseline SHA the plan was reviewed against. On resumption every one of those facts is rechecked, and any drift forces a replan.

**This second pattern is the model AIW-258 should extend rather than replace:** the human does not approve a vague intention, they approve an exact, verifiable scope, and the system refuses to proceed if the world moved underneath that approval.

---

## 3. Guardrails matrix

Decision values are **Allow**, **Block**, and **Approve** (human approval required).

| # | Action | Decision | Enforcement point | Status | User-facing behavior | Audit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Read a restricted file or path inside a checked-out repository | Block | None today. Proposed: exclusion at provisioning, plus a `PreToolUse` deny hook as feedback | **Proposed** | Proposed: the content is absent from the workspace; an attempted access returns a structured denial naming the policy | Proposed: policy id, path, decision on the run attempt |
| 2 | Read a **private** repository that is not in scope | Block | Credential scope plus worker-side provisioning: repositories are cloned by the worker, and the agent holds no credential to fetch another | **Implemented** | The path does not exist in the workspace, and no credential exists to obtain it | Workspace manifest recorded per run |
| 3 | Edit a restricted file or path in a writable repository | Block | None today. Proposed: publication-time path policy in the publisher, plus an in-sandbox hook as feedback | **Proposed** | Proposed: publication fails naming the policy and the offending paths; the run reports a terminal, readable reason | Proposed: policy id, paths, decision, outcome |
| 4 | Edit any file in a read-only (context) repository | Block | Worker-side: hard reset to the research baseline with verification, plus `read_only_changed` at publication | **Implemented** | Edits are discarded before inspection; a changed read-only repository fails publication | Restored repository list; publication `failureKind` |
| 5 | Publish to a repository outside the approved scope | Block | Worker-side: allowlist, workflow pin, approved-scope recheck, per-repository access mode | **Implemented** | The run fails with "replan required", naming the repository and the reason | Approval record, scope recheck failure |
| 6 | Change repository permissions or access configuration | Block | Credential scope: the agent holds no version-control credential, so no provider API call is possible | **Implemented** | The capability does not exist for the agent | No attempt is possible to record |
| 7 | Destructive remote operations (force push, branch or tag deletion, history rewrite) | Block | Credential scope plus the publisher: all publication is worker-performed, with exact target heads and force-with-lease | **Implemented** | The agent cannot reach the remote; a stale lease rejects the push | Publication `failureKind`, target and pushed heads |
| 8 | Create a PR when configured high-risk areas were changed | Approve | None today. Proposed: policy evaluated before the PR-opening step, parking the run through the existing approval mechanism | **Proposed** ([AIW-258](https://blazity.atlassian.net/browse/AIW-258)) | Proposed: the run parks, a named approver is notified in the dashboard, Jira, and Slack; approval resumes the same run, rejection ends it with a visible reason | Proposed: policy id, matched paths, approver, decision, final outcome |
| 9 | Create a PR after an approved plan | Approve | Worker-side: plan approval binds an exact repository scope and baseline, rechecked on resumption | **Implemented** (when the workflow includes the approval block) | The ticket moves, an approval request is raised, the run resumes on approval | Approval record with plan, assumptions, and bound scope |
| 10 | Delegate work to subagents | Block or Allow, per profile | Runtime flags: `--disallowedTools Task` for Claude, `features.multi_agent=false` for Codex, on profile-driven runs | **Implemented (narrow)** | Delegation attempts do not create subagents | Resolved policy in the run's harness manifest |
| 11 | Restrict the agent's tool set (filesystem, shell, git) | Not available | Harness Profile validation rejects any subset | **Implemented as a refusal** | Publishing a profile with a tool subset fails with "tool subsets are not supported by the current provider runtimes" (`apps/worker/src/sandbox/harness-runtime.ts:499`) | Profile version records the declared set |
| 12 | Attach an MCP integration to a Harness Profile | Not available | The integration catalog is empty and the manifest permits zero entries (`apps/shared/contracts/harness-profiles.ts:15`, `apps/worker/src/harness-profiles/manifest.ts:128`) | **Implemented as a refusal** | No MCP integration can be selected | Not applicable |
| 13 | Suppress repository instructions (`CLAUDE.md`, `AGENTS.md`) for a run | Not available | Both pinned CLIs discover repository instructions from the working tree, so the manifest fixes this to always-on (`apps/worker/src/harness-profiles/manifest.ts:92`) | **Implemented as a refusal** | The control is not offered, because it could not be enforced | Not applicable |
| 14 | Commit platform-managed memory into a repository | Block | In-sandbox pre-commit hook (advisory) plus the worker-side publication gate (authoritative) | **Implemented**, authoritative layer only | The commit is refused with an actionable message; publication is the real guard | Hook outcome recorded at provisioning |
| 15 | Outbound network access from inside the sandbox | Unknown | Not established | **Unknown** | Not established | Not established |
| 16 | Unbounded trigger volume or a runaway loop consuming the shared run pool | Block above a configured bound | Partial today: code-owned scheduler concurrency bounds and per-agent duration, token, and cost ceilings. No per-minute, hour, day, or month trigger rate limit yet | **In progress** ([AIW-256](https://blazity.atlassian.net/browse/AIW-256)) | Today a run stops at its own ceiling. In progress: the trigger is refused above the configured rate with a visible reason | Run limits recorded in the harness manifest; trigger-level accounting does not exist |

### Notes on specific rows

- **Rows 1 and 3 are the real gap.** There is no path-level policy anywhere in the product today. Row 2 is a genuine control but a coarse one: it works because out-of-scope repositories are absent from the workspace and the agent has no credential to fetch one, not because reads are filtered.
- **Row 2 is deliberately scoped to private repositories.** Publicly readable content needs no credential, so whether the agent could fetch it depends entirely on sandbox egress, which is row 15 and is **Unknown**. The claim to make is "cannot read another private repository", not "cannot read anything outside scope". Settling row 15 would let row 2 be stated more broadly; until then it must not be.
- **Row 1 cannot be made a perfect hard block.** Once a repository is checked out into a machine the agent controls, in-sandbox read blocking is advisory by the same argument that makes L3 advisory. The deterministic option is to never place the content in the workspace, which is enforceable at provisioning. **Say this plainly rather than promising a read guarantee we cannot keep.**
- **Row 10 updates [AIW-202](https://blazity.atlassian.net/browse/AIW-202)'s framing.** That ticket describes subagent controls as visible but unenforceable. Enforcement now exists for the disabled case on both runtimes. AIW-202 remains valid for the full versioned policy, the Codex concurrency limit, and publication-time validation.
- **Row 15 is genuinely unverified.** The agent must reach its model provider, so egress is not fully closed, but whether any restriction exists was not established. It must not be claimed either way.
- **Row 16 belongs here even though it is not a file-level control.** A guardrail is any deterministic bound the platform enforces against the agent, and an unbounded trigger or looping workflow is a runaway in the same sense as a forbidden write.
- **Audit is the weakest column.** The contract carries a `guardrailHits` field (`apps/shared/contracts/domain.ts:107`), and every real read path writes `null` into it (for example `apps/worker/src/db/queries/runs-read.ts:319`). Only mock data populates it. **The field exists; nothing has ever filled it.**

---

## 4. Recommendation: where guardrails are configured

**Guardrail policy should be a deployment-owned, versioned artifact, pinned by a workflow definition, and enforced by worker-side code at provisioning time and publication time. Harness Profiles should stay out of it.**

1. **Authoring.** A guardrail policy is a versioned, immutable, content-addressed document owned by the deployment, discovered the same way deployment-owned skills are ([AIW-246](https://blazity.atlassian.net/browse/AIW-246), `apps/worker/src/harness-profiles/local-skills.ts`). A tenant ships its policy in its own repository. This inherits a working ownership model instead of inventing a second one.
2. **Binding.** A workflow definition pins an exact policy version, exactly as it pins a Harness Profile version and its repositories ([AIW-191](https://blazity.atlassian.net/browse/AIW-191), [AIW-219](https://blazity.atlassian.net/browse/AIW-219)). Changing policy requires publishing a new version and deploying, so a deployed workflow's behavior never changes underneath its owner.
3. **Enforcement.** Two deterministic points, both in worker code the agent cannot reach:
   - **Provisioning time**, in workspace preparation, for anything decidable before the agent runs: which repositories exist, which are writable, and which paths never enter the workspace.
   - **Publication time**, in the trusted publisher, for anything depending on what the agent actually did: which paths changed, and whether a change requires approval.
4. **Validation.** A policy the runtime cannot enforce **blocks publication of the workflow** rather than being silently ignored. This is the precedent [AIW-202](https://blazity.atlassian.net/browse/AIW-202) sets for subagent policy, and the reason the current code refuses tool subsets instead of pretending to honor them.
5. **Approval.** High-risk decisions park the run through the existing approval mechanism, binding the exact matched paths and policy version into the approval record, the way plan approval binds a repository scope and baseline SHA.

### Why not the alternatives

| Alternative | Why not |
| --- | --- |
| Configure guardrails in Harness Profiles | A profile describes the runtime shape of one agent: CLI, model, instructions, limits. Guardrails are a property of the deployment and the workflow. The profile schema already refuses to express tool restrictions it cannot enforce, and adding path policy there would repeat the mistake it was designed to avoid. Resource ceilings stay in the profile. |
| Enforce with CLI `PreToolUse` hooks | The hook points exist and are already used for tracing, so this is tempting. It is bypassable by construction, for the reasons the memory pre-commit hook comment enumerates. Valuable as immediate agent feedback, never as the authoritative guard. |
| Delegate enforcement to the Arthur Engine | The engine is not an in-loop execution controller and cannot prevent a request from executing. See the [companion document](./2026-08-12-arthur-engine-scope-and-evals.md). Even with its synchronous evaluation API, the blocking decision would still be ours. |
| Rely on review guidance and prompt instructions | This is what AIW-255 was raised to stop doing. Prompt compliance is not enforcement. |

### Relationship to the surrounding systems

| System | Relationship to guardrails |
| --- | --- |
| **Workflow definitions** | Owns the binding: which policy version applies to which workflow, alongside the existing repository pin. |
| **Deployment-owned policy** | The ownership and distribution model to copy from skills: content-addressed artifacts, pinned by version, shipped by the tenant, refreshable with visible drift. |
| **Repository access** | The outer bound. A guardrail policy may **narrow** access; it must never widen it, mirroring the rule that a provider-only workflow scope can only narrow the allowlist. |
| **Harness Profiles** | Owns the runtime envelope: CLI, model, instructions, skills, duration/token/cost ceilings, subagent policy. Does **not** own path or action policy. |
| **Human-in-the-loop** | The approval path. Reuse the approvals store and the `needs_human_input` parking mechanism rather than adding a second one. |

---

## 5. Implementation gaps

| # | Gap | Impact | Where it lands |
| --- | --- | --- | --- |
| G1 | No path-level read or write policy exists anywhere | Matrix rows 1 and 3 are unenforceable | [AIW-258](https://blazity.atlassian.net/browse/AIW-258) |
| G2 | No structured block reason or policy identifier | A blocked action cannot be explained consistently across surfaces | [AIW-258](https://blazity.atlassian.net/browse/AIW-258) |
| G3 | No approval gate for high-risk areas before a PR is opened | Row 8 is unenforceable; plan approval covers scope, not change content | [AIW-258](https://blazity.atlassian.net/browse/AIW-258) |
| G4 | `guardrailHits` is contract-only and never populated | No guardrail activity is visible in any run view | [AIW-258](https://blazity.atlassian.net/browse/AIW-258) |
| G5 | The repository allowlist fails open when unset | A misconfigured deployment silently permits every installed repository | Configuration hardening; candidate follow-up ticket |
| G6 | Subagent policy is enforced only for the disabled case | No concurrency bound, no publication-time validation | [AIW-202](https://blazity.atlassian.net/browse/AIW-202) |
| G7 | Harness Profiles cannot restrict tools or attach MCP integrations | Runtime capability cannot be narrowed per profile | [AIW-182](https://blazity.atlassian.net/browse/AIW-182), [AIW-202](https://blazity.atlassian.net/browse/AIW-202) |
| G8 | Failure causes are hidden behind a generic message | A blocked action could not be diagnosed from the dashboard alone, which would defeat guardrail messaging | [AIW-254](https://blazity.atlassian.net/browse/AIW-254) |
| G9 | Run rows can show a model the run never used | Undermines trust in run-level attribution, including future guardrail attribution | [AIW-253](https://blazity.atlassian.net/browse/AIW-253) |
| G10 | No per-minute, hour, day, or month trigger rate limit | Matrix row 16; a loop or misconfigured schedule can consume the shared run pool | [AIW-256](https://blazity.atlassian.net/browse/AIW-256), [AIW-241](https://blazity.atlassian.net/browse/AIW-241) |
| G11 | Sandbox egress is unverified | Matrix row 15 cannot be answered in either direction | Proposed spike |
| G12 | Guardrail decisions are not covered by replayable scenarios | Allowed, blocked, approval, and rejection paths cannot be regression-tested as product behavior | [AIW-194](https://blazity.atlassian.net/browse/AIW-194), [AIW-196](https://blazity.atlassian.net/browse/AIW-196), [AIW-197](https://blazity.atlassian.net/browse/AIW-197), [AIW-198](https://blazity.atlassian.net/browse/AIW-198) |

### Linked Jira work

| Ticket | Status | Relevance |
| --- | --- | --- |
| [AIW-182](https://blazity.atlassian.net/browse/AIW-182) | Backlog | Capability-driven model and compaction controls for Harness Profiles |
| [AIW-202](https://blazity.atlassian.net/browse/AIW-202) | Backlog | Enforceable subagent controls; sets the "unenforceable selection blocks publication" precedent |
| [AIW-221](https://blazity.atlassian.net/browse/AIW-221) | Implemented, in verification | Repository-filtered workflow with profile-pinned skills; the shape guardrail policy should follow |
| [AIW-239](https://blazity.atlassian.net/browse/AIW-239) | In progress | MCP endpoint; guardrails must apply to agent-driven authoring too |
| [AIW-246](https://blazity.atlassian.net/browse/AIW-246) | Implemented, in verification | Deployment-owned skills, merged via PR #241; the ownership model this document recommends copying |
| [AIW-250](https://blazity.atlassian.net/browse/AIW-250) | To do | Arthur release preflight; guardrail work reaches that tenant only after a sync |
| [AIW-253](https://blazity.atlassian.net/browse/AIW-253) | Verification | Correct model attribution on run rows, merged via PR #247 |
| [AIW-254](https://blazity.atlassian.net/browse/AIW-254) | Verification | Real failure causes surfaced instead of a generic message, merged via PR #250 |
| [AIW-255](https://blazity.atlassian.net/browse/AIW-255) | Verification | The companion Arthur Engine scope and EVALS document, merged via PR #248 |
| [AIW-256](https://blazity.atlassian.net/browse/AIW-256) | In progress | Configurable trigger rate limits; matrix row 16 |
| [AIW-263](https://blazity.atlassian.net/browse/AIW-263) | Verification | This document, merged via PR #249; blocks AIW-258 |
| [AIW-258](https://blazity.atlassian.net/browse/AIW-258) | Planned | Guardrail enforcement. Blocked by AIW-263, and deliberately not part of the current integration pass |
| [AIW-241](https://blazity.atlassian.net/browse/AIW-241) | Backlog | Nothing warns a customer that one schedule can consume the shared run pool |

---

## 6. Demo-ready messaging

### Implemented, and safe to demonstrate

- Every agent runs in an isolated, disposable microVM. It is not a shared machine and it does not survive the run.
- **The agent holds no version-control credential.** It cannot push, cannot open or modify a pull request, and cannot change repository permissions or access settings. All publication is performed by the platform, outside the agent's reach.
- A workflow runs only against an explicitly configured set of repositories, narrowed further by a per-workflow pin.
- Repositories attached for context only are read-only, enforced twice: local edits are discarded and verified before anything is inspected, and a changed read-only repository is refused at publication.
- Publication uses exact expected heads and a lease, so a concurrent change on the remote is rejected rather than overwritten.
- Where a workflow includes plan approval, a human approves an exact repository scope and an exact code baseline. If anything moved between approval and execution, the run refuses to proceed and asks for a new plan.
- Workflows can pause and ask a human a question, then resume the same run on the answer. A run waiting on a person is visible as awaiting input rather than looking stalled.
- Every run is observable, with per-step replay capture in the dashboard.
- Per-agent duration, token, and cost ceilings are enforced from the Harness Profile, so a single run cannot execute without bound.

### Implemented, in verification

- Deployment-owned skills, so a client ships its own review knowledge from its own repository ([AIW-246](https://blazity.atlassian.net/browse/AIW-246)).
- The Arthur private repository-aware post-PR review workflow ([AIW-221](https://blazity.atlassian.net/browse/AIW-221)).

### In progress

- Configurable trigger rate limits across schedule, webhook, ticket, and API triggers ([AIW-256](https://blazity.atlassian.net/browse/AIW-256)).
- Real failure causes and correct model attribution on run rows ([AIW-254](https://blazity.atlassian.net/browse/AIW-254), [AIW-253](https://blazity.atlassian.net/browse/AIW-253)).
- An MCP endpoint for authoring, inspecting, and testing workflows ([AIW-239](https://blazity.atlassian.net/browse/AIW-239)).

### Planned, and must be described as such

These are specified in Jira and **deliberately not part of the current integration pass.** Do not present them as underway.

- Path-level restrictions on which files may be read or edited.
- Human approval required before opening a pull request when configured high-risk areas were touched.
- A structured, named reason surfaced consistently whenever a guardrail blocks an action.
- Guardrail activity visible per run in the dashboard.

All four are [AIW-258](https://blazity.atlassian.net/browse/AIW-258).

### Unknown, and must not be claimed

- Whether outbound network access from the sandbox is restricted (matrix row 15).

### The one paragraph to say out loud

> Guardrails in AI Workflow are enforced by the platform, not by asking the model nicely. The agent works in a disposable, isolated machine with no repository credentials, so it physically cannot publish, cannot alter repository permissions, and cannot write to or publish against any repository outside its configured scope. Everything that reaches your repository is published by the platform after deterministic checks. What we have specified next is finer-grained control of the same kind: naming specific files and areas as restricted, or as requiring a named human approval before a pull request is opened.

---

## 7. AIW-258 implementation brief

[AIW-258](https://blazity.atlassian.net/browse/AIW-258) is **planned, blocked by this document ([AIW-263](https://blazity.atlassian.net/browse/AIW-263)), and deliberately excluded from the current integration pass.** This section is its design input, so that whoever picks it up starts from verified seams rather than from a blank page.

### 7.1 Policy artifact

- A guardrail policy is an immutable, content-addressed, versioned document, discovered from the deployment's own repository exactly as deployment-owned skills are (`apps/worker/src/harness-profiles/local-skills.ts`, [AIW-246](https://blazity.atlassian.net/browse/AIW-246)).
- A policy declares rules of three shapes: `deny_read`, `deny_write`, and `require_approval`, each over path globs, each carrying a stable `policyId` and a human-readable reason.
- A workflow definition pins an exact policy version. Deployed workflows keep their pinned version; changing policy requires publishing and deploying, as with Harness Profile versions.
- **Isolation:** a policy is scoped to one deployment and can only narrow repository access, never widen it. Reuse the composition rule already proven in `isRepoAllowedForScope` (`apps/worker/src/lib/repo-allowlist.ts:94`).

### 7.2 Enforcement point A: provisioning time

- Extend workspace preparation (`apps/worker/src/workflows/blocks/prepare-workspace.ts`, `apps/worker/src/sandbox/manager.ts`) so `deny_read` paths are **excluded from the checkout** rather than filtered at access time.
- This is the only deterministic form a read restriction can take. Document that in-sandbox read denial is advisory, and do not promise otherwise.
- A policy naming a path that cannot be excluded (for example, one required for the build) must fail loudly at workflow publication, not silently at run time.

### 7.3 Enforcement point B: publication time (authoritative)

- Evaluate `deny_write` and `require_approval` over the **changed path set** inside `apps/worker/src/sandbox/trusted-workspace-publisher.ts`, before the push, in the same preflight phase that already produces `read_only_changed`.
- Extend the existing failure union (`apps/worker/src/sandbox/trusted-workspace-publisher.ts:26`) with `policy_blocked`, and carry `policyId`, the matched rule, and the offending paths alongside it.
- This point is authoritative precisely because the agent cannot reach it, which is the doctrine already stated at `apps/worker/src/sandbox/git-excludes.ts:69`.

### 7.4 Approval path

- When a `require_approval` rule matches, park the run through the existing mechanism rather than a new one: the `needs_human_input` exit (`apps/worker/src/workflows/blocks/human-question.ts`) plus the approvals store (`apps/worker/src/approvals/store.ts`, `apps/worker/src/db/approvals-schema.ts`).
- Bind into the approval record the **policy version, the matched rule, and the exact matched paths**, mirroring how `ApprovedRepositoryScope` binds repositories and baseline SHAs (`apps/worker/src/workflows/blocks/send-plan-approval.ts:34`).
- On resumption, **recheck the binding**. If the changed path set no longer matches what was approved, refuse and require a new approval, exactly as approved-scope drift forces a replan (`apps/worker/src/workflows/blocks/prepare-workspace.ts:114`).
- Approval resumes the same run. Rejection ends it with a terminal, user-visible reason.

### 7.5 Structured reason and surface consistency

- A blocked or parked action produces one structured payload: `policyId`, rule kind, matched paths, decision, and a human-readable reason.
- Render it identically in the dashboard, Jira, and Slack. **This depends on [AIW-254](https://blazity.atlassian.net/browse/AIW-254)** (In progress), which routes real causes into the user-facing message path. Without it, a guardrail block would surface as a generic failure and the feature would be invisible where it matters most. Sequence AIW-258 after or alongside it.

### 7.6 Audit

- **Populate `guardrailHits`.** It is declared in the run contract (`apps/shared/contracts/domain.ts:107`) and every read path currently writes `null` (for example `apps/worker/src/db/queries/runs-read.ts:319`). AIW-258 would be its first writer.
- Emit each policy evaluation through the run observation sink (`apps/worker/src/run-observability/`), recording the evaluated policy version, the attempted action, the decision, the actor for an approval, and the final outcome.

### 7.7 Advisory layer (explicitly non-authoritative)

- Install a `PreToolUse` deny hook so the agent gets immediate, actionable feedback instead of discovering the block at publication. The hook points already exist and are occupied by the Arthur tracer (`apps/worker/src/sandbox/agents/claude.ts:31` to `:37`), so the wiring is proven.
- **Document it as user experience, not as a guarantee.** It is bypassable for the reasons enumerated at `apps/worker/src/sandbox/git-excludes.ts:69`.

### 7.8 Validation

- Publishing a workflow whose pinned policy the runtime cannot enforce **fails with an actionable error**. Precedent: [AIW-202](https://blazity.atlassian.net/browse/AIW-202), and the current refusals for tool subsets (`apps/worker/src/sandbox/harness-runtime.ts:499`) and MCP integrations (`apps/worker/src/harness-profiles/manifest.ts:128`).
- A malformed rule costs its own rule only, never the whole policy, mirroring the local-skills failure model.

### 7.9 Test coverage

Cover all six AIW-258 acceptance paths, and make them replayable scenarios so they survive as regression coverage ([AIW-194](https://blazity.atlassian.net/browse/AIW-194) family):

1. Allowed: an ordinary change publishes unaffected.
2. Blocked: a forbidden write is rejected **even when the agent attempts it directly**, including with the in-sandbox hook removed.
3. Approval required: a high-risk change parks the run before the PR exists.
4. Approved: the same run resumes and publishes.
5. Rejected: the run ends with a terminal, visible reason.
6. Misconfiguration: an unenforceable or malformed policy fails at publication, not at run time.

### 7.10 Explicitly out of scope for AIW-258

- **Trigger rate limits and run-pool protection** ([AIW-256](https://blazity.atlassian.net/browse/AIW-256), [AIW-241](https://blazity.atlassian.net/browse/AIW-241)). Related family, separate ticket, already in progress.
- **Sandbox egress control** (matrix row 15). Unverified today; needs its own spike before anything is designed.
- **Harness Profile tool subsetting and MCP integrations** ([AIW-182](https://blazity.atlassian.net/browse/AIW-182), [AIW-202](https://blazity.atlassian.net/browse/AIW-202)).
- **Arthur-side enforcement.** Not available, by the vendor's own architecture. See the [companion document](./2026-08-12-arthur-engine-scope-and-evals.md).

---

## 8. Open questions

1. For matrix row 1, is provisioning-time exclusion (restricted content never enters the workspace) acceptable, given that in-sandbox read denial cannot be a guarantee?
2. Should `AGENT_ALLOWED_REPOS` become required configuration for client deployments, given that it currently fails open?
3. Is sandbox egress restricted? Row 15 is unanswerable today and blocks a broader read claim in row 2.
4. Who authors and owns a tenant's guardrail policy, and does it ship in the same repository as that tenant's skills?

## 9. Evidence inventory

| Source | Use |
| --- | --- |
| Codebase at `533b514f` | Every implementation claim, cited as `file:line` |
| Jira AIW project | Scope and status for every ticket linked above |
| Slack `#ai-workflow`, 2026-05-06 and 2026-05-07 | The Arthur Engine enforcement boundary, recorded directly from the vendor |
| `docs/AI-WORKFLOW-ROADMAP.md` | Consistency check for phase and status language |
