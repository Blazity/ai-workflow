# Workflow Workspace Redesign — Design Spec

Date: 2026-07-07
Status: Approved in brainstorming session; revised through 2026-07-12.
Supports: `docs/workflow-workspace/index.html`, which is the source of truth.

## Purpose

`docs/workflow-workspace/index.html` is the team's **design workspace for the workflows feature** — the surface where the block taxonomy, workflow variants, and open product decisions are iterated on while the workflow editor/orchestration MVP is being designed. It is not a stakeholder demo and not a prototype of the future editor UI.

Two problems with the current file:

1. **The canvas is buggy and unpleasant**: zoom only via ctrl/cmd+wheel, draggable frames with localStorage persistence that fight a clamped fixed-size board, static edges, reload-based reset, blurry text, no navigation aids.
2. **The content predates decisions**: the block set was drafted before the requirements consolidated in `docs/roadmap.md`, `docs/feedback.md`, and the 2026-07-07 feature-estimate notes (local, untracked). The dashboard's mocked node types (`apps/dashboard/lib/flows.ts`) were a stakeholder prototype and are **explicitly discarded** — this is a clean-slate taxonomy informed by the new requirements.

## Decisions made in brainstorming

- **Audience**: design workspace for the team (optimize for iteration and readability).
- **Editing model**: content lives as structured data inside the file; the canvas is a read-only viewer. No in-canvas editing, no dragging, no layout persistence.
- **Content**: clean-slate block taxonomy from the new requirements; dashboard prototype node types discarded.
- **Viewer**: rebuilt spatial canvas (single self-contained HTML file, zero dependencies, deterministic auto-layout, Figma-grade navigation).

## Part 1 — Content: block taxonomy

Grouping principle (from feedback): blocks are **named by provider + capability**, not generic types configured by dropdowns. One color per group, used consistently across registry cards, diagram nodes, and the detail panel.

### Groups and blocks

**1. Lifecycle triggers** (red)

| Block | Output (summary) |
|---|---|
| Ticket implementation started/resumed (configured ticket provider; Jira-only vs Jira + Linear launch coverage is open) | `{ticket, comments, attachments, resume_reason: "new_ticket" \| "moved_to_ai" \| "clarification_answered" \| "comment_added", prior_run?}` |
| Plan approved | `{ticket, approved_plan, approval: {approver, approved_at}}` |
| PR created | `{pr, diff, commits, ticket?}` with `scope: workflow_owned \| any`. Workflow-owned is proven by durable branch/publication correlation plus a valid ticket lookup; `any` is review-safe only. |
| PR checks failed | Allowlisted external GitHub Actions / GitLab CI failure for the current head: `{pr, head_sha, failed_checks, log_refs, provider_delivery_id, producer, ticket?}` with the same scope. Exact event source/granularity remains open. Passing, cancelled, superseded, neutral, skipped, and stale-head results start nothing. |
| PR review submitted | Selected human-authored review feedback for the current head: `{pr, head_sha, review, comment_refs, provider_delivery_id, ticket?}` with the same scope. Exact review-event taxonomy remains open; workflow-authored comments are filtered. |
| PR/MR merged | `{pr, head_sha, merge_sha, merged_at, ticket?}`. `scope: workflow_owned` guarantees a correlated ticket and permits ticket actions; `scope: any` remains PR-only/review-safe. |

A workflow may declare **multiple triggers** feeding the same entry point. Granular low-level triggers (ticket created, comment added, …) are deferred; lifecycle triggers are the MVP surface.

**2. Agents** (violet) — the specialized/generic distinction lives at block level

| Block | Contract (summary) |
|---|---|
| Planning Agent | in: `{ticket, comments, prior_answers?}` → out: `{status: "ready" \| "needs_human_input", plan?, questions?, assumptions?}`. Clarification loop built in. |
| Implementation Agent | in: `{ticket, plan, workspace_policy, branch_policy, verification?}` → out: `{status: "implemented" \| "needs_human_input" \| "failed", workspace_id, branches: BranchRef[], commits, verification?, summary}`. Workspace, branch policy, commit enforcement, and optional final verification built in. Multi-repo: one branch per changed repo. |
| Review Agent | in: `{workspace_id \| pr, scope}` → out: `{status, findings[], decision: "approve" \| "request_changes"}` |
| Fix Agent | in: `{target: PrRef \| TicketContext, workspace_id?, workspace_policy?, source_head_sha?, failures: RemediationItem[], plan?}` → out: `{status: "fixed" \| "needs_human_input" \| "failed", workspace_id, commits, resolved_conflicts?, questions?, summary}`. Reuses a supplied workspace or prepares/resumes one implicitly. `source_head_sha` is required for existing-PR remediation and optional for pre-PR repair. The built-in `fixed` classification continues to Finalize workspace; it is not a CI verdict or a bypass of deterministic publication guards. |
| Generic Agent | in: `{prompt, workspace_id?, output_schema}` → out: declared schema + `{status}`. Non-code uses such as planning need no workspace; repository-reading or mutating configurations must attach one. For custom routing, use a declared classification field in its output schema and evaluate it with Branch; runtime `status` remains reserved for execution/HITL outcomes. |

**3. Workspace** (cyan) — the run-scoped resource

| Block | Contract (summary) |
|---|---|
| Prepare workspace | in: `{target: PrRef \| TicketContext, repo_selection_policy, branch_policy, persistence_policy?}` → out: `{workspace_id, repos: SelectedRepo[], branches: BranchRef[], materialization}`. Optional before specialized agents, which auto-prepare when needed; explicit modular/custom flows use it to control selection and policy. `BranchRef = {provider, repo_path, branch}` (mixed-provider). Warm resume versus cold reconstruction is the proposed model; exact persistence semantics remain open. |
| Finalize workspace | in: `{workspace_id, required_checks?}` → out: `{status: "clean" \| "failed", publication_attempt_id, commits, pushed_branches, verification, artifacts, workspace_state}`. Sole deterministic push boundary: preflight every repo, verify exact source/remote heads and clean committed git state, push with ownership-safe leases, and durably record per-repo results. Finalize does not terminate the workflow or release its active-run claim; that claim remains held through all downstream blocks. It does not create PRs. |

**4. Control** (green)

| Block | Contract (summary) |
|---|---|
| Branch | config: one expression over `steps.*.output` (single condition language) → out: `{path: "true" \| "false", reason}` |
| Loop | config: `{max_attempts, on_exhaust: "fail" \| "human" \| "continue"}` → out: `{attempt}` via two output ports: `continue` (next attempt) and `exhausted` (attempts spent; unwired = default failure path). Every cycle in a workflow must pass through exactly one Loop. |
| Terminate workflow | config: `{terminal_status, post_comment?}` → terminal |

**5. Ticket actions** (blue)

| Block | Contract (summary) |
|---|---|
| Post comment (Jira/Linear) | in: `{ticket, message, reason}` → out: `{comment_id, posted_at}` |
| Update ticket status | in: `{ticket, target_status}` → out: `{update_id}` |

**6. VCS actions** (indigo)

| Block | Contract (summary) |
|---|---|
| Open PR/MR | in: `{publication_attempt_id, branches: FinalizedBranchRef[], title, body}` → out: `{prs: PrRef[]}`. One PR/MR per successfully finalized changed repo; it cannot push or consume a raw workspace. |
| Post PR comment | in: `{pr, message}` → out: `{comment_id}` |
| Fetch PR context | in: `{pr \| ticket}` → out: `{comments, check_results, conflict_status, remediation_context: RemediationItem[]}`. The normalized remediation context feeds Fix Agent directly. |

**7. Human-in-the-loop** (orange, dashboard-backed)

| Block | Contract (summary) |
|---|---|
| Send plan for approval | in: `{ticket, plan, assumptions, reviewers}` → out: `{approval_request_id, dashboard_url}`. Ends this path after persisting the approval item; no workflow instance remains suspended. The `Plan approved` trigger starts the pinned implementation path. |
| Human question | in: `{ticket, questions, scope: "owner" \| "team"}` → out: `{answers, answered_by}`. User-scoped to the ticket owner by default. |

**8. Utility** (slate)

| Block | Contract (summary) |
|---|---|
| Run checks | in: `{workspace_id, scope: "changed_repos" \| RepoRef[], commands?: PerRepoCommands}` → out: `{ok /* every repo passed */, results: RepoCheckResult[], failures: RepoCheckFailure[]}`. Per-repo configured commands; conditions branch on the aggregate, Fix Agent consumes `failures[]`. |
| Call LLM | in: `{prompt, output_schema}` → out: declared schema. Non-agent transform. |
| Send Slack message | in: `{channel, message, context?}` → out: `{message_ts}` |

**9. Arthur Engine add-on** (greyed/optional — core product works without the open-source Arthur Engine)

| Block | Contract (summary) |
|---|---|
| Prompt injection check | in: `{content}` → out: `{ok, findings}` |
| Trace run | passive observability wrapper |

### Runtime guarantees (cross-cutting semantics)

Stated once on the board; they apply to every variant:

1. **HITL is a runtime capability, not a block.** Any agent block may return `status: "needs_human_input"`; the runtime stops it, records the exact pinned checkpoint and safe prior outputs, snapshots unpublished workspace state, and hands the owner claim to a pinned successor that reruns only the waiting agent. This selected path ships only after the real Vercel snapshot/restore/expiry and git-index probe passes. Users cannot build a deadlocking workflow by forgetting a clarification block.
2. **Every block has a precise, discriminated output schema** (`status` discriminant + typed payload), so Branch conditions and Loop exits always operate on structured data. Branch conditions use PR #118's restricted, parsed JavaScript-style expression syntax over `steps.*.output`; arbitrary JavaScript is never evaluated and boolean positions require real booleans. Inputs persist explicit typed paths from `trigger.*`, `steps.<nodeId>.output.*`, or `run.*`; compatible shape matching is editor assistance, not an implicit saved contract.
3. **Workspace state survives continuation.** Unpublished work, repository/branch identity, untracked files, and unresolved conflict-index state survive in the capability-gated snapshot restored by the pinned successor. Snapshot Workflow steps pass only serializable IDs, scrub old credentials, and inject fresh credentials on restore. General warm/cold workspace retention outside pending clarification remains open.
4. **Failure has a default path.** Any block can end `status: "failed"`. Unless an explicit failure edge overrides it, the runtime applies the default policy: terminate the run, move the ticket to the configured column, notify. Graphs draw the happy path — no `if err != nil` ladders.
5. **Runs serialize per subject.** One owner-matching active claim per durable subject. Ticket workflows and durably correlated workflow-owned PRs use `ticket:<provider>:<ticketKey>`; arbitrary PR-only workflows use `pr:<provider>:<repo>#<number>` without sending it to Jira. A branch prefix is never ownership proof. Triggers firing mid-run coalesce into a pending event and start after terminal release.
6. **Keep post-PR mechanisms distinct.** Workflow definitions are the source of truth for AI-run behavior, while provider CI results and human reviews remain authoritative inputs to remediation. The existing product-owned `post-pr-gate`, a possible `PR created → Review Agent` workflow, and CI/review-triggered remediation are separate mechanisms. Which review mechanism to keep, replace, or retire remains open.
7. **Budgets bound active execution.** Definitions may set `maxDurationMs`, `maxTokens`, and `maxCostUsd`. Duration defaults to the job timeout; token/cost are unset until authored. Human waits do not count. Duration can interrupt polling, while token/cost are authoritative only after a phase today, so one phase may overrun but no later block starts. Configured token/cost caps fail closed on missing usage/pricing.

### Explicitly deferred

Nested reusable workflow blocks, MCP editing surface, granular low-level triggers, generic (non-delivery) automation blocks, and arbitrary JavaScript/code steps. JavaScript execution is not part of the MVP.

## Part 2 — Board composition

Eight frames, auto-positioned in reading order (sidebar navigator mirrors this order):

1. **Block Registry** — all groups above, plus the greyed Arthur Engine add-on group and the "explicitly deferred" note.
2. **Runtime guarantees** — the seven cross-cutting semantics above.
3. **V1 · Standard delivery workflow** *(recommended default)* — configured ticket lifecycle providers feed one entry → Planning Agent → Implementation Agent → Finalize workspace → Open PR/MR → Update ticket status + Send Slack message. Finalize is the only push boundary; Open PR only creates provider PRs from finalized branches. Jira-only versus Jira + Linear launch coverage remains open.
4. **V2 · Same lifecycle, fully modular** — proof that generic blocks rebuild V1: trigger → Generic Agent (planning) → Branch on `needs_human_input` → (true) Post comment → Terminate (`waiting_for_human`); (false) → Prepare workspace → Generic Agent (implementation) → Run checks → Branch on `ok` → (false) Loop (max 3, on_exhaust: fail) → Fix Agent → back to Run checks; (true) → Finalize workspace → Open PR/MR. Note folding in the old "LLM branch slug" example: Call LLM proposes, runtime enforces.
5. **V3 · Human-approved plan** — trigger → Planning Agent → Send plan for approval → *persist approval and end this path*; `Plan approved` trigger → Implementation Agent → Finalize workspace → Open PR/MR. **One workflow definition with two entry points**, not two workflows: each trigger starts its own chain, the ticket identity correlates them, and the approval event carries the plan plus exact definition version as payload. No workflow instance remains suspended while approval is pending.
6. **V4 · Review & fix after PR** — the single canonical remediation board. `PR checks failed` + `PR review submitted` triggers → Fetch PR context → Fix Agent (reuses an explicit workspace or re-materializes one implicitly) → on built-in `status: "fixed"`, Finalize workspace (deterministic push guard) → Post PR comment. `needs_human_input` and `failed` follow runtime policy without explicit Branch/Human Question blocks. External CI failures and human-review outcomes drive this remediation flow; V4 itself does not start on PR open/update. This does not decide whether AI Workflow separately retains the existing post-PR gate or offers a PR-created Review Agent workflow. Each actionable failure starts one remediation run for the exact head SHA. The run pushes and ends; provider CI runs on the new SHA, where success starts nothing and failure starts a fresh remediation run. A failure arriving while V4's downstream tail is still running is stored pending and starts only after the owner terminates. No internal post-PR `Run checks`, explicit Prepare workspace, readiness Branch, or Human Question block is drawn.
7. **V5 · Move ticket after merge** — `PR/MR merged` configured with `scope: workflow_owned` → Update ticket status → optional Slack message. Workflow-owned scope statically guarantees a real ticket. Jira status webhooks authored by the configured workflow account are ignored so the workflow does not cancel itself; missing, different, or unverifiable actors retain normal human-move cancellation behavior.
8. **Open Decisions** — live product questions: post-PR review ownership and its relationship to PR-created review; whether a future explicit policy may mutate arbitrary PR branches; general persistent-workspace lifecycle beyond pending clarification; Jira-only vs Jira + Linear launch coverage; actionable review-event scope; CI event source/granularity; deployment ownership scope; missed-event recovery; multi-repository remediation semantics; and Arthur tracing policy. Mutable Save Draft, immutable explicit Deploy/Rollback, exact-version pinning, capability-gated pinned clarification, six provider/ticket lifecycle trigger types, Plan approval, restricted parsed Branch syntax, no JavaScript step, and explicit typed input bindings are locked.

### Node density

Nodes are **compact cards**: title, one-line description, one-line contract (e.g. `out: plan | questions`). Full input/output schemas are NOT rendered inside nodes. Clicking a node (or a registry card) opens a read-only **detail panel** with the block's group, description, full I/O schemas, and notes. Schemas live in a **shared dictionary keyed by block type** — defined once, referenced from every variant.

Frames are positioned by the layout algorithm. Nodes *within* a frame keep authored `x, y` coordinates in the data (predictable, hand-tunable; no graph-layout engine).

## Part 3 — Viewer: interaction model

Figma conventions:

- Two-finger scroll / wheel → **pan** (both axes).
- Pinch or `⌘`/`Ctrl`+wheel → **zoom at cursor**.
- Left-drag on empty canvas → pan (grab cursor); middle-drag → pan. Nothing is draggable.
- Keyboard: `0` fit-all, `1`–`8` fly to frame N, `+`/`−` zoom, `Esc` closes detail panel.
- **Sidebar navigator**: fixed list of the eight frames; click flies there with an animated tween (~350 ms ease). Prev/Next controls included.
- Double-click a frame header → zoom to fit that frame.
- **Deep links**: URL hash tracks the focused frame (e.g. `#v3-approved-plan`); on load, a matching hash flies there.
- View (x, y, scale) persists to localStorage. **Reset view** = animated fit-all (no reload). Zoom clamped to roughly 10%–200%.
- Touch: pointer-events-based pan + pinch zoom.

## Part 4 — Implementation structure

One self-contained `index.html` (no external dependencies, opens from `file://`), three regions:

1. **`<style>`** — refined version of the existing warm paper aesthetic; group colors as CSS custom properties; one color per registry group.
2. **Content data** — a single `BOARD` object: registry groups; frames in reading order; per-frame nodes (`id`, `type` → block-type key, `x`, `y`, optional title/body overrides), edges (`from`, `to`, optional `label`), notes; and the shared `BLOCKS` schema dictionary (per block type: group, description, contract line, full input/output schema text).
3. **Engine** (~400 lines) —
   - Deterministic frame layout: row packer with a max row width; registry gets a full-width row; fixed gaps.
   - DOM rendering for frames/nodes/notes; one SVG per frame for edges (bezier, arrowheads with **per-frame marker ids**, labels with halo backgrounds).
   - Pan/zoom on a single transformed board element (`translate3d` + `scale`); no permanent `will-change` so text re-rasterizes crisp after zoom settles.
   - rAF tween for fly-to/fit; hash sync; detail panel open/close; keyboard handling.

**Removed entirely** (bug surface, not fixed but deleted): frame dragging, layout persistence, coordinate clamping against a fixed board size, reload-based reset, ctrl-only wheel zoom.

**Not included by decision**: minimap, dark mode, in-canvas editing, external libraries.

## Success criteria

- Opens from `file://` with no console errors; renders all eight frames.
- Trackpad navigation feels native: scroll pans, pinch zooms at cursor, no modifier keys required to move around.
- Every node and registry card opens the detail panel with full schemas; `Esc`/click-away closes it.
- Sidebar, number keys, and hash deep-links all land on the right frame with a smooth tween.
- Fit-all frames the whole board correctly at any window size.
- Text is crisp at rest at any zoom level.
- Content changes (adding a block, a node, or a variant) require only edits to the `BOARD`/`BLOCKS` data — no engine changes.

## Revision — 2026-07-07 design review

After an adversarial review against the current runtime (AIW-45 multi-repo/mixed-provider work, pre-sandbox and post-PR gate specs), four decisions were made and folded into this spec and the board:

1. **Persistent workspaces (partially resolved 2026-07-17).** Pending clarification targets a snapshot-backed pinned successor and is gated on a real Vercel snapshot/restore/expiry and git-index probe. General named-sandbox persistence, cold rebuild, TTL/keep-last, and park/destroy policy outside that handoff remain open. (Drives remain private beta and are not load-bearing.)
2. **Default failure policy** (guarantee #4): failures route to a built-in terminate/move/notify policy unless an explicit failure edge overrides — keeps graphs happy-path-only.
3. **Multi-repo collection semantics**: collections stay inside blocks (per-repo arrays + aggregates on outputs, e.g. `Run checks`); runs serialize per subject and triggers coalesce (guarantee #5); `BranchRef`/`PrRef` carry `provider` for mixed-provider deployments; the Loop rule is restated at cycle level.
4. **AI behavior and post-PR ownership** (guarantee #6, reopened 2026-07-17): this review preferred workflow definitions for AI-run behavior and repository CI / human reviewers for post-PR verdicts. V4 still reacts to external failure/review events and ends after publishing a fix, but whether the internal `post-pr-gate` is retained, replaced by an editable PR-created review workflow, or retired is open again.

Still open (added to the Open Decisions frame): the general persistent-workspace model/lifecycle beyond the capability-gated clarification handoff. Plan approval separately re-enters through the locked `Plan approved` trigger. Explicit typed input bindings were subsequently locked for the MVP.

A second review pass (same day) made four refinements: the agent group is labeled just "Agents" (Generic Agent is not specialized — the distinction is block-level); `Attach workspace` was removed as vestigial (specialized agents implicitly prepare or reuse a supplied `workspace_id`, while modular flows use Prepare workspace); `Loop` gained an explicit `exhausted` output port (unwired, it follows the default failure path); and V3 is explicitly documented as one workflow definition with two entry points, correlated by ticket, with the approval event carrying the plan as payload.

## Revision — 2026-07-12 external validation ownership (reopened 2026-07-17)

This review preferred repository CI and reviewers as the owners of post-PR validation. Under that option, the target architecture would not recreate GitHub Actions / GitLab CI checks, publish competing statuses, or start a validation workflow on PR open/head update. A failed external CI result or actionable human review would start a remediation run for the exact head SHA; the run would push a fix and end. CI would evaluate the new SHA normally: passing CI starts nothing, while another failure starts a fresh remediation run. This matches the original use case in `docs/feedback.md` lines 164–167.

The current runtime still dispatches the product-owned post-PR gate from GitHub/GitLab PR/MR head events. Authenticated CI-completion and human-review subscriptions/normalizers are required for event-driven remediation regardless. The 2026-07-17 review reopened whether the existing gate should then be kept, replaced by editable review workflow blocks, or retired in favor of repository CI / external reviewers.

## Sources

- `docs/roadmap.md` §2–3 (core workflow model, editor requirements)
- `docs/feedback.md` (workflow editor, workflow scope, rough sketch sections)
- 2026-07-07 feature-estimate notes, local/untracked (MVP boundaries, open decisions)
- `docs/pre-sandbox-plan.md`, `docs/post-pr-gate-spec.md` (existing lifecycle extension points)
- Discarded as input by decision: `apps/dashboard/lib/flows.ts` node taxonomy (stakeholder prototype)
