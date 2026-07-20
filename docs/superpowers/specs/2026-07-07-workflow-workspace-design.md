# Workflow Workspace Redesign — Design Spec

Date: 2026-07-07
Status: Approved in brainstorming session; awaiting implementation plan.
Replaces: `docs/workflow-workspace/index.html` (current sketch canvas, to be rewritten from scratch).

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
| Ticket implementation started/resumed (Jira/Linear) | `{ticket, comments, attachments, resume_reason: "new_ticket" \| "moved_to_ai" \| "clarification_answered" \| "comment_added", prior_run?}` |
| Plan approved | `{ticket, approved_plan, approval: {approver, approved_at}}` |
| PR created | `{pr, diff, commits, ticket?}` |
| PR checks failed | `{pr, failed_checks, logs, ticket?}` |
| PR review submitted | `{pr, review, comments, ticket?}` |

A workflow may declare **multiple triggers** feeding the same entry point. Granular low-level triggers (ticket created, comment added, …) are deferred; lifecycle triggers are the MVP surface.

**2. Agents** (violet) — the specialized/generic distinction lives at block level

| Block | Contract (summary) |
|---|---|
| Planning Agent | in: `{ticket, comments, prior_answers?}` → out: `{status: "ready" \| "needs_human_input", plan?, questions?, assumptions?}`. Clarification loop built in. |
| Implementation Agent | in: `{ticket, plan, workspace_policy, branch_policy, verification?}` → out: `{status: "implemented" \| "needs_human_input" \| "failed", workspace_id, branches: BranchRef[], commits, verification?, summary}`. Workspace, branch policy, commit enforcement, and optional final verification built in. Multi-repo: one branch per changed repo. |
| Review Agent | in: `{workspace_id \| pr, scope}` → out: `{status, findings[], decision: "approve" \| "request_changes"}` |
| Fix Agent | in: `{workspace_id, failures: RepoCheckFailure[] \| ReviewFeedback, plan?}` → out: `{status: "fixed" \| "needs_human_input" \| "failed", commits, summary}` |
| Generic Agent | in: `{prompt, workspace_id?, output_schema}` → out: declared schema + `{status}`. Must attach a workspace to touch code. |

**3. Workspace** (cyan) — the run-scoped resource

| Block | Contract (summary) |
|---|---|
| Prepare workspace | in: `{ticket, repo_selection_policy, branch_policy, persistence_policy?}` → out: `{workspace_id, repos: SelectedRepo[], branches: BranchRef[], materialization: "created" \| "resumed_warm" \| "rebuilt_cold"}`. Materializes the ticket's durable workspace; owns multi-repo selection. `BranchRef = {provider, repo_path, branch}` (mixed-provider). |
| Finalize workspace | in: `{workspace_id, required_checks?}` → out: `{status: "clean" \| "failed", commits, pushed_branches, verification, artifacts, workspace_state: "parked" \| "destroyed"}`. Deterministic end gate: clean git state, commits exist, push changed branches, artifact capture; then **park** (snapshot + stop, for non-terminal ends) or **destroy** (terminal statuses). |

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
| Open PR/MR | in: `{workspace_id \| branches, title, body}` → out: `{prs: PrRef[]}`. One PR/MR per changed repo. |
| Post PR comment | in: `{pr, message}` → out: `{comment_id}` |
| Fetch PR context | in: `{pr \| ticket}` → out: `{comments, check_results, conflict_status}` |

**7. Human-in-the-loop** (orange, dashboard-backed)

| Block | Contract (summary) |
|---|---|
| Send plan for approval | in: `{ticket, plan, assumptions, reviewers}` → out: `{approval_request_id, dashboard_url}`. Suspends until the `Plan approved` trigger fires. |
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

1. **HITL is a runtime capability, not a block.** Any agent block may return `status: "needs_human_input"`; the runtime posts the questions, suspends the workflow, and the lifecycle trigger's resume path re-enters it. Users cannot build a deadlocking workflow by forgetting a clarification block.
2. **Every block has a precise, discriminated output schema** (`status` discriminant + typed payload), so Branch conditions and Loop exits always operate on structured data. One condition language everywhere.
3. **The workspace is runtime-owned and two-tier**: a durable identity (ticket → repos + branches + manifest, in our DB) materialized into an ephemeral sandbox — **warm** from a persistent-sandbox snapshot (Vercel Sandbox v2 named sandboxes), or **cold** by re-cloning the workflow-owned branches. Snapshot expiry degrades warm to cold, never fails a run; cold is the only path on-prem. Threaded via `workspace_id`, always finalized. Specialized agents prepare/attach implicitly; generic workflows compose the workspace blocks explicitly. LLM steps may *propose* values (e.g. a branch slug); the runtime *enforces* policy (validation, creation, naming).
4. **Failure has a default path.** Any block can end `status: "failed"`. Unless an explicit failure edge overrides it, the runtime applies the default policy: terminate the run, move the ticket to the configured column, notify. Graphs draw the happy path — no `if err != nil` ladders.
5. **Runs serialize per ticket.** One active run per ticket (claim registry). Triggers firing mid-run coalesce into the resume path instead of spawning parallel runs; a ticket leaving the AI column cancels its active run. Multi-repo collections stay inside blocks: outputs carry per-repo arrays plus aggregates for conditions.
6. **One configuration surface.** Workflow definitions are the single source of truth for run behavior. The in-repo `pre-sandbox.yaml` and `post-pr-gate.yaml` pipelines are deprecated; their steps (repo selection, complexity check, injection check, PR gates) become blocks inside workflows.

### Explicitly deferred

Nested reusable workflow blocks, MCP editing surface, granular low-level triggers, generic (non-delivery) automation blocks. The JS-step question (editable execution logic vs read-only visualization) is an open decision, not silently resolved.

## Part 2 — Board composition

Seven frames, auto-positioned in reading order (sidebar navigator mirrors this order):

1. **Block Registry** — all groups above, plus the greyed Arthur Engine add-on group and the "explicitly deferred" note.
2. **Runtime guarantees** — the six cross-cutting semantics above.
3. **V1 · Standard delivery workflow** *(recommended default)* — multi-trigger (Jira + Linear stacked into one entry) → Planning Agent → Implementation Agent → Open PR/MR → Update ticket status + Send Slack message. Note listing what the specialized agents absorb (clarification loop, workspace, branch policy, commit enforcement, pre-PR verification).
4. **V2 · Same lifecycle, fully modular** — proof that generic blocks rebuild V1: trigger → Generic Agent (planning) → Branch on `needs_human_input` → (true) Post comment → Terminate (`waiting_for_human`); (false) → Prepare workspace → Generic Agent (implementation) → Run checks → Branch on `ok` → (false) Loop (max 3, on_exhaust: fail) → Fix Agent → back to Run checks; (true) → Finalize workspace → Open PR/MR. Note folding in the old "LLM branch slug" example: Call LLM proposes, runtime enforces.
5. **V3 · Human-approved plan** — trigger → Planning Agent → Send plan for approval → *durable wait*; `Plan approved` trigger → Implementation Agent → Open PR/MR. **One workflow definition with two entry points**, not two workflows: each trigger starts its own chain, the ticket identity correlates them, and the approval event carries the plan as payload.
6. **V4 · Review & fix after PR** — `PR checks failed` + `PR review submitted` triggers → Fetch PR context → Fix Agent (re-materializes the ticket's workspace: warm from parked snapshot, cold from branches) → Finalize workspace (push) → Post PR comment. Loop policy bounds rounds; check failures coalesce per ticket. Subsumes the deprecated `post-pr-gate.yaml` pipeline.
7. **Open Decisions** — live product questions: condition language choice; JS step editable vs read-only; persistent workspace rollout (SDK v2 migration, snapshot TTL/keep-last, park-vs-destroy rules, cost guardrails); MVP trigger list; plan approval in MVP or after; how much PR review to own vs delegate (CodeRabbit et al.); suspend vs end-and-re-enter for human waits; input binding mechanism (auto-wire vs template expressions).

### Node density

Nodes are **compact cards**: title, one-line description, one-line contract (e.g. `out: plan | questions`). Full input/output schemas are NOT rendered inside nodes. Clicking a node (or a registry card) opens a read-only **detail panel** with the block's group, description, full I/O schemas, and notes. Schemas live in a **shared dictionary keyed by block type** — defined once, referenced from every variant.

Frames are positioned by the layout algorithm. Nodes *within* a frame keep authored `x, y` coordinates in the data (predictable, hand-tunable; no graph-layout engine).

## Part 3 — Viewer: interaction model

Figma conventions:

- Two-finger scroll / wheel → **pan** (both axes).
- Pinch or `⌘`/`Ctrl`+wheel → **zoom at cursor**.
- Left-drag on empty canvas → pan (grab cursor); middle-drag → pan. Nothing is draggable.
- Keyboard: `0` fit-all, `1`–`7` fly to frame N, `+`/`−` zoom, `Esc` closes detail panel.
- **Sidebar navigator**: fixed list of the seven frames; click flies there with an animated tween (~350 ms ease). Prev/Next controls included.
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

- Opens from `file://` with no console errors; renders all seven frames.
- Trackpad navigation feels native: scroll pans, pinch zooms at cursor, no modifier keys required to move around.
- Every node and registry card opens the detail panel with full schemas; `Esc`/click-away closes it.
- Sidebar, number keys, and hash deep-links all land on the right frame with a smooth tween.
- Fit-all frames the whole board correctly at any window size.
- Text is crisp at rest at any zoom level.
- Content changes (adding a block, a node, or a variant) require only edits to the `BOARD`/`BLOCKS` data — no engine changes.

## Revision — 2026-07-07 design review

After an adversarial review against the current runtime (AIW-45 multi-repo/mixed-provider work, pre-sandbox and post-PR gate specs), four decisions were made and folded into this spec and the board:

1. **Persistent workspaces (two-tier model).** The worker's destroy-in-`finally` behavior dates from Sandbox SDK v1, where ephemeral was the platform default. Vercel Sandbox v2 (docs updated 2026-06) makes **persistence the default**: named sandboxes, auto-snapshot on stop, `getOrCreate` resume, TTL + keep-last retention, ~$0.08/GB-month snapshot storage (32 GB filesystem cap). Decision: workspace = durable identity in our DB; warm materialization = resume the persistent named sandbox; cold materialization = fresh sandbox re-cloned from workflow-owned branches. Cold must always work (snapshot expiry, on-prem); warm is a fast path, never a correctness dependency. (Drives — mountable persistent volumes — remain private beta, single-writer; not load-bearing.) Rollout details are an Open Decision.
2. **Default failure policy** (guarantee #4): failures route to a built-in terminate/move/notify policy unless an explicit failure edge overrides — keeps graphs happy-path-only.
3. **Multi-repo collection semantics**: collections stay inside blocks (per-repo arrays + aggregates on outputs, e.g. `Run checks`); runs serialize per ticket and triggers coalesce (guarantee #5); `BranchRef`/`PrRef` carry `provider` for mixed-provider deployments; the Loop rule is restated at cycle level.
4. **Workflows are the single source of truth** (guarantee #6): the in-repo `pre-sandbox.yaml` / `post-pr-gate.yaml` pipelines are deprecated; their steps become workflow blocks. V4 subsumes the post-PR gate.

Still open (added to the Open Decisions frame): suspend vs end-and-re-enter for human waits; input binding mechanism; persistent-workspace rollout details.

A second review pass (same day) made four refinements: the agent group is labeled just "Agents" (Generic Agent is not specialized — the distinction is block-level); `Attach workspace` was removed as vestigial (nothing consumed `workspace_ref`; agents take `workspace_id` directly); `Loop` gained an explicit `exhausted` output port (unwired, it follows the default failure path); and V3 is explicitly documented as one workflow definition with two entry points, correlated by ticket, with the approval event carrying the plan as payload.

## Sources

- `docs/roadmap.md` §2–3 (core workflow model, editor requirements)
- `docs/feedback.md` (workflow editor, workflow scope, rough sketch sections)
- 2026-07-07 feature-estimate notes, local/untracked (MVP boundaries, open decisions)
- `docs/pre-sandbox-plan.md`, `docs/post-pr-gate-spec.md` (existing lifecycle extension points)
- Discarded as input by decision: `apps/dashboard/lib/flows.ts` node taxonomy (stakeholder prototype)
