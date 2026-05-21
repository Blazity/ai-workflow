# PR Review & Pre-Research Extensions - Implementation Plan

**Status:** draft  
**Date:** 2026-05-20 (revised 2026-05-21)  
**Source spec:** `docs/superpowers/specs/2026-05-19-pr-review-extensions-design.md`

## Assumptions

- Implement v1 only for both extension points: opt-in Pre-Research as a new step inside `agentWorkflow`, and a GitHub-App-driven PR Review pipeline with `complexity` and `ai_review` checks.
- Pre-Research and the Review Pipeline share `src/lib/agentic-loop.ts`. Build the shared helper once, then layer both features on top.
- Pre-Research runs in the host Vercel Function before sandbox provisioning. It does not run inside the sandbox and does not write to the repo or GitHub.
- Keep both rollouts dark by default: `review.enabled: false` and `preResearch.enabled: false` in `workflow.config.yaml`.
- Treat `workflow.config.yaml` as deployment-owned config in this repo. Target PRs and tickets cannot change their own review or pre-research rules.
- Use existing Nitro/H3 route conventions, Workflow DevKit `"use workflow"` / `"use step"` boundaries, colocated Vitest tests, and the current VCS adapter pattern.
- Confirm current Vercel AI SDK exports (`generateText`, `generateObject`, `stopWhen`, `stepCountIs`, `tool()`, `experimental_telemetry`) and accepted Anthropic model IDs against official AI SDK docs during the agentic-loop and AI-check slices before enabling production config.
- v1 ships exactly one `web_search` backend for Pre-Research. The choice (AI-SDK provider-defined search, or a thin wrapper over Tavily/Brave/Linkup behind `WEB_SEARCH_API_KEY`) is finalized in Milestone 4 and stays configurable later.
- Redis cache for Pre-Research reuses the existing `AI_WORKFLOW_KV` schema and key prefix conventions.

## Success Criteria

### Review Pipeline

- Invalid review config fails startup or config loading before any review runs.
- GitHub pull request webhook verifies `X-Hub-Signature-256`, filters action/repo/scope, starts `reviewWorkflow`, and returns quickly.
- Each enabled configured check publishes exactly one Check Run per check/head SHA/config hash.
- Same-SHA webhook redeliveries do not duplicate work, comments, or suggestions.
- Independent checks continue after failures; dependent checks respect `needs` and `skip_on_dependency_failure`.
- Complexity findings are limited to changed functions in changed files.
- AI checks support `per_file` and `whole_pr` modes with structured output and deterministic fingerprints.
- Check Run annotations, summaries, PR comments, and suggestions honor severity thresholds and caps.
- Cache manifests in Check Run output are parsed/written, and bad manifests degrade to cache misses.

### Pre-Research

- Invalid `preResearch` config fails startup before any ticket runs.
- `preResearch.enabled: false`, missing config, or `on_failure: skip` failures leave `agentWorkflow` running with `preResearchBrief: null`; the existing Research/Impl prompts handle that cleanly.
- `on_failure: fail` moves the ticket back to `COLUMN_BACKLOG` and emits a `failed` event with `phase: pre_research`.
- The agentic loop respects `stopWhen` step cap and the `max_duration_seconds` wall-clock deadline.
- `runRegistry` cancellation between agent steps aborts the loop cleanly.
- Unknown tool names in config are rejected at startup; only whitelisted tools are exposed to the model.
- Cache hit returns the previous brief without invoking the model. Cache key invalidates when prompt source/hash, model, or enabled-tool set changes.
- `pass_to` controls which assemblers (Research, Impl, both) receive the brief; the `<pre_research_brief>` block appears in the assembled prompt only when present.
- Usage tokens land in `phaseUsages["Pre-Research"]` and the Slack/Jira notification renders the Pre-Research sub-status.

### Shared

- `pnpm test`, `pnpm typecheck`, and a preview-deployment manual end-to-end test (one ticket exercising Pre-Research + sandbox phases, then a PR exercising the review pipeline) pass before rollout.

## Milestone 1: Config Foundation

Add the deployment-owned config and validation layer covering both `review` and `preResearch`.

Files:

- `workflow.config.yaml`
- `src/lib/workflow-config.ts`
- `src/lib/workflow-config.test.ts`
- `env.ts`
- `package.json`

Implementation:

1. Add `workflow.config.yaml` with `review.enabled: false`, `preResearch.enabled: false`, and a minimal example-compatible structure for both blocks.
2. Add `GITHUB_WEBHOOK_SECRET`, optional `WORKFLOW_CONFIG_PATH`, and optional `WEB_SEARCH_API_KEY` to `env.ts`.
3. Add `yaml` as a dependency.
4. Implement config loading, Zod schemas for `review` and `preResearch`, normalized defaults, and a stable `configHash` that covers both blocks.
5. Validate review: check IDs, unknown check kinds, `needs`, dependency order, dependency cycles, thresholds, and per-check params.
6. Validate preResearch: enabled flag, scope modes, prompt source, tool whitelist (reject unknown tool names), limits, cache mode, `on_failure`, and `pass_to` targets.
7. Gate startup behavior: missing `GITHUB_WEBHOOK_SECRET` is fatal when `review.enabled: true`; missing `WEB_SEARCH_API_KEY` is fatal when `preResearch.enabled: true` and `web_search` is whitelisted with a backend that requires it.

Verify:

- Config tests cover valid review + preResearch config, invalid YAML, unknown check kind, unknown `needs`, later-check `needs`, cycles, invalid thresholds, unknown pre-research tool, invalid `pass_to`, and missing required env when each feature is enabled.
- `pnpm test src/lib/workflow-config.test.ts`
- `pnpm typecheck`

## Milestone 2: Shared Check Model

Create the small check framework before implementing any concrete check.

Files:

- `src/lib/checks/types.ts`
- `src/lib/checks/registry.ts`
- `src/lib/checks/result.ts`
- `src/lib/checks/result.test.ts`

Implementation:

1. Add `Severity`, `Finding`, `CheckResult`, cache manifest, `PRContext`, `CheckContext`, and `Check` types from the spec.
2. Add severity ordering helpers and Check Run conclusion mapping.
3. Add an initially explicit registry for v1 kinds, with implementations wired in later slices.
4. Keep workflow execution generic: dispatch by registry lookup, not by check-kind branches.

Verify:

- Unit tests cover severity comparisons and blocking/non-blocking conclusion mapping.
- `pnpm test src/lib/checks/result.test.ts`
- `pnpm typecheck`

## Milestone 3: Shared Agentic Loop Helper

Build the shared AI SDK agent-loop helper that both Pre-Research and `ai_review` whole-PR mode depend on. Build this once so future tools added for one feature are immediately available to the other.

Files:

- `src/lib/agentic-loop.ts`
- `src/lib/agentic-loop.test.ts`
- `package.json`

Implementation:

1. Add `ai` and `@ai-sdk/anthropic` dependencies.
2. Confirm exact AI SDK exports (`generateText`, `generateObject`, `stopWhen`, `stepCountIs`, `tool()`, `experimental_telemetry`) against current AI SDK docs before locking the helper signature.
3. Export an `agenticLoop({ model, system, prompt, tools, stopWhen, telemetry })` helper that wraps `generateText` with `stopWhen: stepCountIs(...)` and `experimental_telemetry: { isEnabled: true }`.
4. Return parsed text + structured-output payload (optional `generateObject` follow-up), `steps`, `usage`, and `finishReason`.
5. Enforce a wall-clock deadline alongside `stopWhen` step cap.
6. Tools are pure functions backed by adapters or fetch; the helper itself does not know about specific tools — callers provide the tool belt.
7. Surface cancellation: accept an `AbortSignal` so callers can plumb `runRegistry` cancellation.

Verify:

- AI SDK is mocked in tests; no network calls.
- Tests cover step-cap enforcement, wall-clock deadline, abort-on-cancel, structured-output parsing tolerance for trailing/leading non-JSON noise, and usage extraction.
- `pnpm test src/lib/agentic-loop.test.ts`
- `pnpm typecheck`

## Milestone 4: Pre-Research Tool Belt And Step

Add Pre-Research types, tool belt, cache helpers, and the `runPreResearch` step. Land mocked-AI-SDK unit tests before wiring into `agentWorkflow`.

Files:

- `src/lib/pre-research-types.ts`
- `src/lib/pre-research-tools.ts`
- `src/lib/pre-research-tools.test.ts`
- `src/lib/pre-research-cache.ts`
- `src/lib/pre-research-cache.test.ts`
- `src/lib/pre-research.ts`
- `src/lib/pre-research.test.ts`
- `src/adapters/vcs/types.ts`
- `src/adapters/vcs/github.ts`
- `src/adapters/vcs/github.test.ts`
- `src/adapters/vcs/gitlab.ts`
- `src/adapters/vcs/gitlab.test.ts`

Implementation:

1. Add `PreResearchReference`, `PreResearchBrief`, and `PreResearchInput` types from the spec.
2. Implement the tool belt: `web_search`, `fetch_url` (respect `max_fetch_bytes`), `search_codebase` (via `vcs.searchCode`), `read_file_at_ref` (via VCS adapter), `query_tracker` (via tracker adapter), `search_past_prs` (via `vcs.searchMergedPRs`). Each tool returns structured errors on transient failures so the model can decide to continue.
3. Add `vcs.searchCode` and `vcs.searchMergedPRs` to the GitHub adapter; GitLab adapter throws `NotSupported` for v1 unless trivial to implement.
4. Add Redis-backed cache keyed by `ai_workflow:preresearch:<ticket_id>:<rev_hash>:<config_hash>` with TTL from config.
5. Implement `runPreResearch` as a `"use step"` function: compute ticket revision hash, check cache, run `agenticLoop` with whitelisted tools, parse structured brief, enforce `max_brief_bytes` and `max_references` caps, log per-tool-call summaries at `debug`.
6. Pick the v1 `web_search` backend and document the choice in `workflow.config.yaml` and `SETUP.md`. v1 ships exactly one; the choice is configurable later.
7. Choose or add a glob-matching dependency only if existing dependencies cannot satisfy real glob semantics needed by config patterns.

Verify:

- AI SDK is mocked. Tool implementations are unit-tested with adapter mocks.
- Tests cover: cache hit returns previous brief without invoking the model; cache key invalidates on prompt/model/enabled-tool change; `fetch_url` respects `max_fetch_bytes`; `search_codebase`/`read_file_at_ref` route through the VCS adapter; unknown tool name rejected by config; tools return structured errors on transient failures; structured output parser tolerates trailing/leading non-JSON noise; `runRegistry` cancellation between steps aborts cleanly.
- GitHub tests cover `searchCode` and `searchMergedPRs` request shapes.
- GitLab tests cover `NotSupported` for the methods not implemented.
- `pnpm test src/lib/pre-research.test.ts src/lib/pre-research-tools.test.ts src/lib/pre-research-cache.test.ts`
- `pnpm typecheck`

## Milestone 5: Wire Pre-Research Into Agent Workflow

Thread the brief into Research and Impl context assemblers, then insert `runPreResearch` into `agentWorkflow`.

Files:

- `src/sandbox/context.ts`
- `src/lib/prompts.ts`
- `src/workflows/agent.ts`
- `src/workflows/agent.test.ts`
- `src/workflows/prompts-step.ts`
- `src/workflows/prompts-step.test.ts`

Implementation:

1. Extend `assembleResearchPlanContext` and `assembleImplementationContext` to accept an optional `preResearchBrief?: string`. When present, prepend a clearly-delimited block:

   ```text
   <pre_research_brief>
   {brief_markdown}
   </pre_research_brief>
   ```

2. Update Research and Implementation prompt scaffolds in `src/lib/prompts.ts` to instruct the sandbox agent to trust the brief as additional context but verify any code-level claims against the repo.
3. Insert `runPreResearch` into `agentWorkflow` between `fetchAndValidateTicket` and `provisionSandbox`.
4. Apply `preResearch.scope` (all / label / branch_prefix) before invoking the step. When disabled or out of scope, pass `preResearchBrief: null` to the assemblers.
5. Apply `pass_to` so the brief reaches only the configured downstream assemblers (research, impl, or both).
6. Handle `on_failure: skip` (continue with `null`) and `on_failure: fail` (move ticket back to `COLUMN_BACKLOG`, emit `failed` event with `phase: pre_research`).
7. Record usage tokens/cost under `phaseUsages["Pre-Research"]` and render the Pre-Research sub-status in the existing Slack/Jira notification under `started`.
8. Extend named-prompt loading in `src/workflows/prompts-step.ts` for the `pre-research` builtin prompt name (sources: `arthur`, `local`, `builtin`).

Verify:

- Tests cover: scope filtering for all/label/branch_prefix; `enabled: false` short-circuits and returns `null`; `pass_to` controls which assemblers receive the brief; `on_failure: skip` continues workflow; `on_failure: fail` returns ticket to backlog with the `pre_research` phase tag; assembled Research/Impl prompts include the `<pre_research_brief>` block when present and omit it otherwise; usage lands in `phaseUsages["Pre-Research"]`.
- `pnpm test src/workflows/agent.test.ts src/workflows/prompts-step.test.ts`
- `pnpm typecheck`

## Milestone 6: Review VCS Surface

Extend VCS adapters with the PR-review operations needed by the review workflow. The `searchCode`/`searchMergedPRs` additions for Pre-Research landed in Milestone 4; this milestone adds the rest.

Files:

- `src/adapters/vcs/types.ts`
- `src/adapters/vcs/github.ts`
- `src/adapters/vcs/github.test.ts`
- `src/adapters/vcs/gitlab.ts`
- `src/adapters/vcs/gitlab.test.ts`

Implementation:

1. Add review-specific adapter types for PR metadata, files, patches, changed line ranges, full diff, file contents at a ref, PR commits, Check Runs, annotations, and PR review comments.
2. Implement GitHub methods using the existing App-auth Octokit instance.
3. Use Check Run `external_id = ai-workflow:<configHash>:<checkId>:<headSha>` for same-SHA dedupe.
4. Implement batched PR review creation when practical, with fallback to individual review comments only if needed.
5. Add GitLab methods that throw a clear `NotSupported` error for v1 review-pipeline calls.

Verify:

- GitHub tests cover request shapes for PR files, diff, file content, Check Run create/update/list, annotations, and review comments.
- GitLab tests cover `NotSupported` for each new review method.
- `pnpm test src/adapters/vcs/github.test.ts src/adapters/vcs/gitlab.test.ts`
- `pnpm typecheck`

## Milestone 7: GitHub Pull Request Webhook

Add the GitHub App webhook route that safely starts the review workflow.

Files:

- `src/routes/webhooks/vcs/github/pull-request.post.ts`
- `src/routes/webhooks/vcs/github/pull-request.post.test.ts`
- `src/lib/dispatch-review.ts`

Implementation:

1. Read raw body and verify `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`.
2. Parse only `pull_request` payloads and accept `opened`, `synchronize`, `reopened`, and `labeled`.
3. Reject invalid signatures with `401`.
4. Reject repos other than configured `GITHUB_OWNER/GITHUB_REPO`.
5. Apply top-level `review.scope` for `all`, `label`, and `branch_prefix`.
6. Start `reviewWorkflow` with only serializable args: owner, repo, PR number, head SHA, and action.
7. Return `200` quickly after the workflow is enqueued or after an ignored event is classified.

Verify:

- Tests cover HMAC valid/invalid/missing, unsupported action ignored, wrong repo rejected, disabled review ignored, and each scope mode.
- `pnpm test src/routes/webhooks/vcs/github/pull-request.post.test.ts`
- `pnpm typecheck`

## Milestone 8: PR Context Assembly

Centralize all data fetching, filtering, and limit enforcement outside checks.

Files:

- `src/lib/pr-context.ts`
- `src/lib/pr-context.test.ts`

Implementation:

1. Fetch PR metadata from GitHub by number inside workflow steps; do not trust the webhook payload as complete context.
2. Fetch changed files, patches, changed line ranges, full diff, prior comments, and optional ticket/acceptance criteria context.
3. Apply global `default_ignore` before file-count and diff-size limits.
4. Support per-check requested data keys: `diff`, `file_diff`, `file_content`, `changed_files`, `prior_comments`, `prior_findings`, `ticket`, and `acceptance_criteria`.
5. Skip deleted files for per-file AI checks.
6. Produce explicit coverage notices for ignored/skipped/truncated/oversized data.

Verify:

- Tests cover ignore-before-limits, deleted-file skips, oversized file content skips, full diff truncation with a notice, and changed-line parsing.
- `pnpm test src/lib/pr-context.test.ts`
- `pnpm typecheck`

## Milestone 9: Complexity Check

Ship the deterministic built-in check first because it does not depend on AI or prompt loading.

Files:

- `src/lib/checks/complexity.ts`
- `src/lib/checks/complexity.test.ts`
- `src/lib/checks/registry.ts`
- `package.json`

Implementation:

1. Add the `complexity` check params schema.
2. Use the TypeScript compiler API to parse JS/TS/JSX/TSX files.
3. Compute cyclomatic complexity from full function bodies.
4. Report only functions whose declaration/body overlaps changed diff lines.
5. Map findings to stable fingerprints and primary locations.
6. Ensure `typescript` is available at runtime if the deployed bundle excludes dev dependencies.

Verify:

- Tests cover changed function reported, unchanged function ignored, ignore patterns, threshold behavior, parse errors as notices, and JSX/TSX parsing.
- `pnpm test src/lib/checks/complexity.test.ts`
- `pnpm typecheck`

## Milestone 10: AI Review Check And Prompt Loading

Add the configurable AI reviewer on top of `src/lib/agentic-loop.ts`, after the data path and output types are stable.

Files:

- `src/lib/checks/ai-review.ts`
- `src/lib/checks/ai-review.test.ts`
- `src/workflows/prompts-step.ts`
- `src/workflows/prompts-step.test.ts`
- `src/lib/prompts.ts`
- `src/lib/checks/registry.ts`

Implementation:

1. Confirm accepted Anthropic model IDs against current official AI SDK docs before choosing production config examples.
2. Extend prompt loading for explicit `arthur`, `local`, and `builtin` review prompt sources.
3. Build `generateObject` calls with the spec's structured output schema for `per_file` mode; build whole-PR runs on top of `agenticLoop` for tool-using review when `data` includes `prior_findings` or similar synthesis inputs.
4. Implement `per_file` mode with per-file data isolation, skip behavior, per-check limits, and aggregation into one `CheckResult`.
5. Implement `whole_pr` mode with requested data and dependency findings.
6. Derive stable finding fingerprints from check ID, head SHA, path, line range, severity, message, and suggestion content.

Verify:

- AI SDK is mocked in tests; no network calls in unit tests.
- Tests cover `per_file`, `whole_pr`, missing ticket context, prior findings, deleted/oversized file skips, max findings, prompt source identity, fingerprint stability, and that `whole_pr` shares `src/lib/agentic-loop.ts` with Pre-Research (same helper exercised by both test suites).
- `pnpm test src/lib/checks/ai-review.test.ts src/workflows/prompts-step.test.ts`
- `pnpm typecheck`

## Milestone 11: Cache And GitHub Output Mapping

Implement reusable output helpers before wiring the workflow.

Files:

- `src/lib/checks/cache.ts`
- `src/lib/checks/cache.test.ts`
- `src/lib/check-output.ts`
- `src/lib/check-output.test.ts`

Implementation:

1. Serialize and parse hidden Check Run cache manifests in `output.text`.
2. Validate cache identity: repo, PR number, check ID, kind, AI mode, model, prompt hash/version, params hash, file path, and content hash.
3. Treat missing, invalid, or too-large manifests as cache misses.
4. Convert findings to GitHub Check Run annotations with caps and overflow summary text.
5. Convert findings to PR review comments and suggestions with thresholds, changed-line anchoring, hidden idempotency markers, and caps.
6. Prefer normal comments or Check Run summary entries when suggestions cannot anchor cleanly to changed diff lines.

Verify:

- Tests cover manifest parse failures, cache invalidation, annotation caps, no-location findings, comment thresholding, suggestion validity, max comments, max suggestions, and marker dedupe.
- `pnpm test src/lib/checks/cache.test.ts src/lib/check-output.test.ts`
- `pnpm typecheck`

## Milestone 12: Review Workflow Orchestration

Wire the route, config, context, checks, cache, output mapping, and GitHub publishing together.

Files:

- `src/workflows/review.ts`
- `src/workflows/review.test.ts`

Implementation:

1. Add `reviewWorkflow(args)` with `"use workflow"`.
2. Keep orchestration in the workflow body and all I/O/heavy work in `"use step"` functions.
3. Load validated config and re-fetch PR metadata by API.
4. For each enabled check in configured order:
   - verify dependencies
   - skip dependency-blocked checks with a neutral Check Run
   - find existing Check Run by external ID
   - skip exact same-SHA duplicates when possible
   - create/update Check Run to `in_progress`
   - load previous cache when configured
   - run the check through the registry
   - publish annotations, summary, cache manifest, comments, and suggestions
   - complete the Check Run with mapped conclusion
5. Continue independent checks after failures.
6. Publish internal check errors as completed Check Runs with failure or neutral conclusion depending on `blocking`.

Verify:

- Tests cover configured order, dependency result passing, dependency skip, independent continuation after error, same-SHA dedupe, blocking/fail-on mapping, and internal error publishing.
- `pnpm test src/workflows/review.test.ts`
- `pnpm typecheck`

## Milestone 13: Setup Docs And Rollout

Document operator setup for both features and run one controlled end-to-end validation.

Files:

- `SETUP.md`
- `docs/GITHUB-APP-SETUP.md`
- `workflow.config.yaml`

Implementation:

1. Document GitHub App webhook URL `/webhooks/vcs/github/pull-request`, required webhook event, secret, and permissions.
2. Document the review config fields and dark-launch rollout: start with `review.enabled: false`, then `scope.mode: label`, then `scope.mode: all`.
3. Document the Pre-Research config fields, `pass_to` semantics, scope modes, tool whitelist, cache TTL, `WEB_SEARCH_API_KEY` (when applicable), and dark-launch rollout: start with `preResearch.enabled: false`, then `scope.mode: label`, then `scope.mode: all`.
4. Add a small, safe sample config with one non-blocking complexity check, one optional label-scoped AI check, and an opt-in `preResearch` block with `on_failure: skip` and `pass_to: [research, impl]`.

Verify:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- Preview deployment manual end-to-end:
  - Move a test ticket into `COLUMN_AI` with the Pre-Research label; confirm the brief is generated, cached, and threaded into the Research/Impl prompts; confirm `phaseUsages["Pre-Research"]` and the Slack/Jira sub-status appear.
  - Open a PR with no label and confirm no review when scoped by label.
  - Add the review label and confirm the workflow starts; confirm Check Runs, annotations, comments, suggestions, cache manifest, and dedupe on webhook redelivery.
  - Push a new commit and confirm checks rerun for the new head SHA.

## Suggested PR Slices

1. Config foundation (review + preResearch) and check framework.
2. Shared `agentic-loop.ts` helper.
3. Pre-Research tool belt, cache, and step (with mocked AI SDK tests).
4. Pre-Research wiring into `agentWorkflow` (context assemblers, prompt scaffolds, `phaseUsages`, notifications).
5. VCS review adapter additions.
6. GitHub webhook and review dispatch.
7. PR context assembly.
8. Complexity check.
9. AI review on top of `agentic-loop.ts`, plus prompt loading.
10. Cache/output mapping.
11. Review workflow integration.
12. Docs and rollout validation.

Each slice should include its own tests and typecheck before the next slice starts.
