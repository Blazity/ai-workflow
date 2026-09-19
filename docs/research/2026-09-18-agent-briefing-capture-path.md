# Agent Briefing: where every prompt is sent from, and where a briefing can be written

Spike note, 2026-09-18, stage 0 of
the Agent Briefing plan (an unmerged draft, since replaced by [the agent visibility plan](../plans/2026-09-19-agent-visibility.md)). Branch
`feat/agent-briefing-visibility`, worktree base
`9f580d8add82d6a2e14acf2a0a49f1486facd7f7`. Question: for every model call that
shapes a run's work, where is the prompt finally composed, which `"use step"`
sends it, what identity is in scope there, and what may be written without a new
`"use step"` and without changing any step's module path or function name.

Method: read-only. Worker and package sources read in this worktree; the
Workflow DevKit read from the copy installed here
(`node_modules/.pnpm/@workflow+core@4.8.0_@opentelemetry+api@1.9.0/…`, version
pinned at `apps/worker/package.json:77`). No code changed, no test suite run,
nothing observed on production. Claims that are read from code and not proven
on production are marked as such. Research notes carry no `Status:` /
`Last-verified:` header by the rule in `docs/index.md:10` ("Every document
outside `archive/` and `research/`…"); this file follows that convention and is
dated instead.

## 1. Every send

"Send" here means: the run hands a prompt to a model whose output shapes the
work. Only the V2 scheduler exists on this path (`executeV2Graph`,
`engine/agent-workflow.ts:4406`; every invocation goes through `executeV2Block`,
`:4036`), so there is no separate V1 send to capture.

### 1.1 The sandbox sends (one shape, three step functions)

Every sandbox send is the same shape: the prompt is a *string argument* of a
zero-retry step that writes it into the sandbox as a file and launches the CLI
detached.

| Send | Prompt composed at | Step that sends it | Step file:line (`"use step"`) | Prompt is an argument? |
|---|---|---|---|---|
| Repository discovery (inside `prepare_workspace`, also lazily from planning/implementation) | `engine/agent-workflow.ts:2018-2021` (`assembleRepositoryDiscoveryPrompt`, `engine/repository-discovery/runner.ts:73-114`) | `writeAndStartPhase` | `engine/steps/phase.ts:461` (`:480`), `maxRetries = 0` `:552` | yes, `inputContent` `phase.ts:466`, call `agent-workflow.ts:2022-2030` |
| Planning/research pass (every pass of the loop) | `engine/agent-workflow.ts:2838-2852` (`resolveAgentInput`) | `writeAndStartPhase` | as above | yes, call `agent-workflow.ts:2854-2864` |
| Implementation | `engine/agent-workflow.ts:3306-3322` | `writeAndStartPhase` | as above | yes, call `:3324-3329` |
| Review | `engine/agent-workflow.ts:3568-3582` | `writeAndStartPhase` | as above | yes, call `:3584-3589` |
| `generic_agent` | `engine/blocks/generic-agent/execute.ts:370-380` | `blockGenericAgentStartPhaseStep` | `engine/blocks/generic-agent/execute.ts:116` (`:129`), `maxRetries = 0` `:196` | yes, call `:427-436` |
| `fix_agent` | `engine/blocks/fix-agent/execute.ts:733-742` | `blockFixAgentStartPhaseStep` | `engine/blocks/fix-agent/execute.ts:311` (`:324`) | yes, call `:770-779` |

Two facts follow, and they decide the whole design:

- **The full prompt text is already a journaled step argument today**
  (`phase.ts:466`, `generic-agent/execute.ts:121`, `fix-agent/execute.ts:316`).
  The Workflow DevKit serializes step arguments into the run's event log
  (`sandbox/agents/redact.ts:10-12`), so a briefing that stores the same bytes
  adds no exposure that is not there already.
- **The harness extras are already a step argument too**: `scriptContent` is
  the complete wrapper script with the CLI binary, every flag and the JSON
  schema (`phase.ts:468`, built by `planPhaseStep` `phase.ts:604-629` from
  `sandbox/agents/claude.ts:204-247`).

`writeAndStartPhase` already carries an optional trailing argument whose only
job is a durable side write: `workScopeWrite?: RunWorkScopeWrite`
(`phase.ts:470-484`), applied by `applyRunWorkScopePlans`
(`engine/work-scope/apply-plans.ts:38-63`) with a deferred database import, a
try/catch and a `logger.warn` on failure. That is the exact precedent for the
briefing write, including the reasoning about why it may ride a zero-retry step
(`apply-plans.ts:19-36`).

### 1.2 Where the prompt actually comes from

Every sandbox send except discovery goes through one compiler seam:

`resolveAgentInput` (`engine/helpers/resolve-agent-input.ts:17-35`) →
`execution.compileEffectivePrompt`, which is the per-invocation closure
`compileInvocationPrompt` (`engine/agent-workflow.ts:4073-4196`) →
`compileEffectivePrompt` (`engine/helpers/effective-prompt.ts:101-125`,
`packages/prompts/effective-prompt.ts:190-380`).

The compiler returns `EffectivePromptCompilation`
(`packages/prompts/effective-prompt.ts:135-142`): `prompt`, `hash`, `sections`,
`provenance`, `unresolvedSources`, `issues`. A section
(`:39-45`) is `{ kind, title, content, hash, provenance[] }` with
`kind ∈ profile | repository | memory | block | runtime` (`:25-30`), and
provenance (`:32-37`) is `{ kind, id, version, hash }`. Sections are rendered
with explicit sentinels and joined with `\n\n` (`:373`, `renderSection`
`:713-720`), so the compiled prompt is fully decomposable and section offsets
are computable without re-rendering. Content is sanitized and capped at 200 000
characters per section (`:144`, `:703-707`).

**All of that is thrown away at `agent-workflow.ts:4195`**, which returns
`{ ok: true, prompt: compilation.prompt }` to satisfy the shared seam type
`packages/workflow-graph/interpreter.ts:206-216`. The sections, the hashes and
the provenance exist for one expression and are then unreachable.

Discovery does not use the compiler at all: its prompt is assembled inline
(`repository-discovery/runner.ts:73-114`), so it has no sections, no profile
instructions and no repository instruction sources.

### 1.3 The planning loop: how many sends per attempt

The planning block loops inside a single invocation (`agent-workflow.ts:2629`)
and restarts on a human repository attach (`:2705`), a model repository request
(`:2942`), a review-ledger correction (`:3005`) and a no-change retry (`:3034`).
Each restart recompiles and calls `writeAndStartPhase` again, so **one Block
Attempt can hold many sends**. The attempt number cannot separate them, and the
code says so where it fixes the artifact names:
`researchPhaseIdentity` (`engine/blocks/support/types.ts:496-537`), comment at
`:514-516`: "The attempt number cannot separate them, being fixed for the whole
execution (AIW-400)." That function already produces a unique, deterministic
per-pass label and artifact phase (expansion round, human attach round,
expansion closed, no-change retry), which a briefing should store beside its
sequence number.

The refusal and "expansion closed" notes that explain a run like AWP-235 are
pushed into the research additions only from the second pass on
(`agent-workflow.ts:2770-2829`), which is precisely why per-send capture is
required rather than per-attempt.

### 1.4 Identity available at the send

| Identity | Available at the send? | Evidence |
|---|---|---|
| Run id | yes | `workflowRunId` from `getWorkflowMetadata()` `agent-workflow.ts:463`; in every block executor as `ctx.runId` (`engine/blocks/support/types.ts:72-73`) |
| Block Attempt **row id** (`workflow_block_attempts.id`) | **no** | `serial` (`db/schema/runs.ts:333`), returned by `startV2RunObservationAttemptStep` into the sink closure (`agent-workflow.ts:946-960`) and never placed on the invocation context (`packages/workflow-graph/interpreter.ts:194-222` has no attempt id) |
| Block Attempt **identity** (run, node, attempt, activation scope) | yes | `invocation.attempt` / `invocation.activationScopeId` `agent-workflow.ts:4289-4290`, `node.id`; that four-tuple is the row's unique index `db/schema/runs.ts:362-367` |
| Per-attempt pass counter | **does not exist**; derivable in workflow scope without a step | the loop is a plain `for(;;)` in the workflow body (`agent-workflow.ts:2629`); a counter incremented there is deterministic under replay, and `researchPhaseIdentity` (`types.ts:496-537`) already gives each pass a unique label |

### 1.5 Model calls that are not sandbox sends

| Call | Step | Shapes the work? |
|---|---|---|
| `call_llm` | `blockCallLlmGenerateStep` `engine/blocks/call-llm/execute.ts:52` (`:60`), call `:132-140` | yes. The whole prompt, system prompt, schema and model are **already** the step's argument object, so it needs no new plumbing at all |
| `investigate` keywords and theory | `blockInvestigateKeywordsStep` `engine/blocks/investigate/execute.ts:292` (`:297`), `blockInvestigateTheoryStep` `:471` (`:476`) | yes; same shape (prompt is the argument) |
| `leak_review` LLM scan | `blockLeakReviewLlmScanStep` `engine/blocks/leak-review/execute.ts:506` (`:511`) | no: report-only, must never fail a run (`:500-504`) |
| Repo-memory distillation | `engine/steps/repo-memory-steps.ts:919-925` | no: it writes memory for later runs |
| Arthur injection check | `blockArthurValidatePromptStep` `engine/blocks/arthur-injection-check/execute.ts:12` (`:16`) | no: a guardrail service, not a model shaping work |
| Clarification answer reader | `services/work-scope/read-answer.ts:128-170` (model call `:139-145`), outside the workflow | out of scope by the plan: shown through its Round |
| Post-PR gate code hygiene | `post-pr-gate/steps/code-hygiene.ts:145`, inside `runGate` (`engine/post-pr-gate-workflow.ts:20-24`, `"use step"` `:21`) | separate detached workflow with no Block Attempt rows; out of scope, worth naming so nobody looks for its briefing |

**Not found:** any `v1`/legacy send path still reachable (searched
`agent-workflow.ts` for a non-V2 scheduler: only `executeV2Graph` at `:4406`).
The `fallbackInput` branch of `resolveAgentInput`
(`engine/helpers/resolve-agent-input.ts:24-26`) is dead in production because
`compileEffectivePrompt` is always supplied at `agent-workflow.ts:4294`.
**Not found:** any existing prompt capture (searched `apps/worker/src` for
`briefing`, `promptSnapshot`, `prompt_snapshot`, `capturePrompt`).

## 2. Capture path options

### (a) Extra data on an EXISTING step's arguments — recommended

Add one optional trailing parameter to the three send steps
(`writeAndStartPhase` `phase.ts:461`, `blockGenericAgentStartPhaseStep`
`generic-agent/execute.ts:116`, `blockFixAgentStartPhaseStep`
`fix-agent/execute.ts:311`) and do a best-effort insert inside the step body,
mirroring `applyRunWorkScopePlans` (`engine/work-scope/apply-plans.ts:38-63`).

- No new `"use step"`, no module path or function name change, no call added or
  removed, so no journal position moves (see §3).
- The prompt text and the wrapper script are already arguments, so the new
  parameter carries only the index and the structured context: a few KB.
- Optional parameters that read as "absent" are the established convention for
  exactly this reason (`engine/steps/repository-instructions.ts:90-108`: "Optional
  so a journal written before this parameter existed still replays").
- Replay consequence: none for a completed step (result comes from the
  journal); for a step created but not completed across a deploy the step runs
  with the pre-deploy arguments, so that one send has no briefing and the read
  model must say so (§3, case ii).

### (b) The Block Attempt observation channel — rejected for the briefing

`invocation.observations` (`agent-workflow.ts:4293`, type
`packages/workflow-graph/invocation-context.ts:1-23`) buffers in workflow scope
(`run-observability/runtime-hooks.ts:462-467`) and is drained into the four
jsonb envelope columns of `workflow_block_attempts`
(`db/schema/runs.ts:349-352`) by `flushV2RunObservationsStep`
(`engine/steps/telemetry.ts:485`), `updateV2RunObservationWaitingStep` (`:541`)
and `finishV2RunObservationAttemptStep` (`:604`). It carries a large payload
badly, for four independent reasons:

1. **Hard byte caps.** 64 KB per field and 256 KB per attempt row
   (`run-observability/sanitizer.ts:13-14`), enforced by
   `enforceReplayAttemptStorageBudget` (`:1123-1155`); a single string over
   512 000 characters or an input over 2 MB is refused outright and the envelope
   becomes unavailable (`:16-19`). A 512 KB briefing cannot fit, and several
   passes in one attempt certainly cannot.
2. **Last-writer-wins slots.** Only `log` appends; `input`, `output` and
   `metadata` are replaced (`run-observability/runtime-hooks.ts:174-197`), so a
   briefing on `metadata` would be overwritten by the agent's own metadata emit
   at the end of the same attempt
   (`run-observability/agent-observations.ts:160-205`).
3. **Not durable while the attempt runs.** The start step writes identity only
   (`engine/steps/telemetry.ts:423-461`); envelopes land at waiting, finish, an
   explicit flush or finalize (`runtime-hooks.ts:537-632`). A briefing is meant
   to be readable while the agent is still working.
4. **Best effort by design.** The capture breaker can switch the channel off for
   a whole run (`runtime-hooks.ts:390-403`, ceiling
   `run-observability/limits.ts:1`).

It is, however, the right channel for a *pointer*: one small metadata
observation saying a briefing exists for this attempt, if the dashboard ever
wants it without a second query.

### (c) Other paths considered

- **Widen the interpreter seam** so `compileEffectivePrompt` returns sections
  (`packages/workflow-graph/interpreter.ts:206-216`). Rejected: it is a shared
  cross-package contract consumed by the scheduler, and the same data can travel
  on a worker-owned object (§7).
- **A new `"use step"` that writes the briefing.** Forbidden by the plan, and
  correctly: a call inserted before existing calls shifts every later
  correlation id (§3e) and strands runs in flight. The repository already
  records this reasoning twice
  (`engine/steps/repository-instructions.ts:80-86`;
  `docs/plans/2026-09-11-repository-catalog-and-settings.md:91`).
- **Write from workflow scope directly.** Impossible: the workflow isolate may
  not touch the database at all (`apps/worker/AGENTS.md`, run context rule;
  guard `engine/workflow-import-boundary.test.ts`).

## 3. Replay verdict, from the installed Workflow DevKit

Version 4.8.0 (`apps/worker/package.json:77`; installed copy
`node_modules/.pnpm/@workflow+core@4.8.0_@opentelemetry+api@1.9.0/node_modules/@workflow/core/dist`,
paths below are relative to that `dist`).

- **Matching is by correlation id, never by arguments.** Each call mints a
  correlation id from the run's ULID sequence (`step.js:14`) and a consumer
  ignores every event whose correlation id differs (`step.js:56`). The
  ULID generator is seeded per run and drawn with a fixed timestamp
  (`workflow.js:80-84`, `:105`), so the id is effectively the ordinal of the
  call in the step/hook/sleep sequence.
- **A completed step's result comes from the journal regardless of arguments.**
  On `step_completed` the promise resolves from `event.eventData.result`
  (`step.js:121-149`). The new call's `args` are used only to build the queue
  item (`step.js:15-20`) and a debug log line.
- **No argument comparison exists.** Searched the installed `dist` for
  `eventData.input`, `deepEqual`, `isDeepStrictEqual`, `hash`, `mismatch`,
  `nondetermin`: **not found**. The only divergence checks are the step *name*
  at the same correlation id (`step.js:60-67`), a `step_created` for an id no
  longer queued (`:71-83`), an unexpected event type (`:160-163`) and, the
  broad one, an event nobody consumed (`workflow.js:95`). Three replay retries
  then `CORRUPTED_EVENT_LOG` (`runtime.js:580-607`,
  `runtime/constants.js:62`, `classify-error.js:94-95`).
- **A step created but not completed executes with the RECORDED arguments.**
  Arguments are serialized once at creation
  (`runtime/suspension-handler.js:194-207`), a re-suspended item with
  `hasCreatedEvent` is not created again (`:183`), and the executor hydrates the
  stored input (`runtime/step-handler.js:360`). An added field on such a step
  silently never reaches the function.
- **Order and count matter, field additions do not.** Adding or removing a step
  call shifts every later correlation id and the stale event finds no consumer
  (`workflow.js:95`). Adding a field to an argument changes no id.

**Verdict for option (a): safe without a drain**, on three conditions: add no
step/hook/sleep call, remove none, reorder none; do not move or rename the
function or its file; make the new parameter optional and make "absent" read as
"no briefing was recorded". The one exposure is the case above: a run suspended
inside `writeAndStartPhase` across the deploy runs it with pre-deploy arguments
and produces no briefing for that single send.

Two caveats that keep this honest:

- **Runs are pinned to the deployment that started them.** `start()` defaults
  `deploymentId` to the current deployment
  (`runtime/start.js:65-67`), and no `start(agentWorkflow, …)` call in the
  worker passes one (`services/dispatch/dispatch.ts:157`,
  `dispatch-trigger.ts:818`, `manual-dispatch/service.ts:551`,
  `webhook-trigger/dispatch-webhook-trigger.ts:304`,
  `approvals/dispatch.ts:170`, `schedule-trigger/dispatch-schedule-trigger.ts:1215`
  and `:1255`). Read from code only: **not proven on production**. If it holds,
  in-flight runs never see the new code at all and even case (ii) cannot occur.
  Worth one cheap production check (`deploymentId` of a run in flight before and
  after a deploy) before anyone leans on it.
- **No byte cap on step arguments was found** in `@workflow/core`,
  `@workflow/world`, `@workflow/world-vercel` or `@workflow/errors` (searched
  `MAX_*SIZE`, `payload`, `too large`, `413`, `exceeds`). The repository sets its
  own budgets for exactly this reason
  (`engine/steps/pre-pr-checks-runner.ts:1784`, "persisted in the run's event
  log … a repository that has lost runs to CORRUPTED_EVENT_LOG"). Keep the new
  argument small; the prompt itself is already there.

## 4. What the harness sends beside the prompt

The prompt is written to `/tmp/<phase>-requirements.md`
(`sandbox/agents/claude.ts:249-260`, `codex.ts:291-302`) and piped into the CLI
by the wrapper script.

**Claude** (`sandbox/agents/claude.ts`): `--print --model <id>
--dangerously-skip-permissions --output-format json` (`:208`),
`--disallowedTools Task` on a pinned runtime (`:211-213`), `--effort <level>`
from the manifest (`:214-216`), `--json-schema '<schema>'` (`:217-220`),
`export HOME=<profile home>` plus `source <env file>` (`:227-228`),
`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (`:229`), the pipe itself (`:232-234`) and the
post-run `rm -rf .claude/` in the checkout (`:239-242`). Around it:
`~/.claude/settings.json` hooks including the commit guard (`:561-620`,
`:162-196`), the onboarding marker `~/.claude.json` (`:57-63`), the Arthur
tracer and its config (`:510-559`), pinned skills under
`<home>/.claude/skills/` and the profile home file `<home>/CLAUDE.md`
(`sandbox/harness-runtime.ts:363-425`), CLI
`@anthropic-ai/claude-code@2.1.216` (`sandbox/agents/protocol.ts:39-47`).

**Codex** (`sandbox/agents/codex.ts`): `codex exec` with `--model`,
`--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`,
`--json`, `-o /tmp/<phase>-result.json` (`:219-243`), `-c
features.codex_hooks=true` and `-c features.multi_agent=false` (`:224-225`),
`-c model_reasoning_effort/service_tier/model_verbosity/model_auto_compact_token_limit`
(`:226-241`), `--output-schema` written by heredoc (`:245-255`), prompt on
stdin via trailing `-` (`:272-275`). Around it: `~/.codex/config.toml` on the
legacy path only (`:120-135`), `codex login` into `~/.codex/auth.json`
(`:140-158`), hooks (`:511-597`), Arthur tracer (`:599-645`), skills under
`<home>/.agents/skills/` and home file `<home>/AGENTS.md`
(`sandbox/harness-runtime.ts:363-385`), CLI `@openai/codex@0.144.6`
(`sandbox/agents/protocol.ts:48-63`).

**A briefing can honestly record**: the wrapper script verbatim (it holds no
secrets: credentials are `source`d from a separate file,
`claude.ts:79-92`), provider, model id, reasoning effort, service tier,
verbosity, compaction mode, the JSON output schema, CLI package and version and
the protocol id, the artifact paths, which config files and hooks we wrote,
pinned skill names with their artifact hashes and byte counts, the profile home
file with its hash, and declared versus effective versus clipped capabilities.
All of that is already resolved before the send and a redacted copy exists as
`safeManifest` (`sandbox/harness-runtime.ts:552-653`, collected at
`agent-workflow.ts:802-806`).

**A briefing cannot see**: the CLI's own system prompt, its tool definitions and
built-in skills; the repository's own `AGENTS.md` / `CLAUDE.md` as the CLI
discovers them from the working tree, which is stated in the manifest schema
itself (`harness-profiles/manifest.ts:93-96`: "Both supported CLIs
discover repository instructions from the working tree"), so those instructions
reach the model twice and only our copy is recordable; nested per-directory
instruction files; anything the CLI compacts away mid-run; sub-agent prompts.
Declared profile `tools` must not be shown as enforced: only
`--disallowedTools Task` is actually enforced (`claude.ts:211-213`), and Codex
has no tool flag at all.

**Not found** anywhere under `apps/` or `packages/` (non-test): `--mcp-config`,
`mcpServers`, `--append-system-prompt`, `--system-prompt`, `--max-turns`,
`--permission-mode`, `--allowedTools`, `ANTHROPIC_MODEL`. MCP into the sandbox
is deliberately closed (`packages/contracts/harness-profiles.ts:15`, reason at
`sandbox/harness-runtime.ts:45-51`).

## 5. The repository context in a send, and its inputs

| Context piece | Rendered by | Rendered from | Where the input object lives | In scope at the send? |
|---|---|---|---|---|
| Discovery catalog entries | `assembleRepositoryDiscoveryPrompt` `repository-discovery/runner.ts:106` | `RepositoryCatalogEntry[]` (`repository-discovery/catalog.ts:14-25`), built in the pre-sandbox step (`engine/pre-sandbox/steps/repo-selection.ts:107`), carried out as `ctx.repositoryDiscovery` (`blocks/prepare-workspace/execute.ts:1210`) | workflow body | **yes**: `offered` and `prompt` are locals at `agent-workflow.ts:2004-2021`; `offered` is what the model actually saw, `ctx.repositoryDiscovery.catalog` is the pre-filter list |
| Discovery `description` | `catalog.ts:188` (truncated to 240 chars, `:10`) | the **provider listing** (`adapters/vcs/repository-directory.ts:252` GitHub, `:322` GitLab) | pre-sandbox step | yes as text; **no source marker exists anywhere** — this is F2 of the plan, and a briefing can only record the string, not its origin, until stage 7 |
| Relationship lines for discovery | `renderRepositoryRelationshipLines` `catalog.ts:45-109`, attached `:112-123` | `RepositoryCatalogRelationship[]` from `listConnectedRepositoryRules` (`db/repositories/repository-catalog.ts:1204`) | pre-sandbox step (`repo-selection.ts:581-601`) | rendered sentences yes (`entry.relationships`); **the structured rows never leave the step** |
| Repository instruction sources (AGENTS.md, CLAUDE.md, `.ai/memory/*`, catalog rules) | `loadRepositoryInstructionSources` (`engine/steps/repository-instructions.ts:87`, `"use step"` `:110`), called through `loadInvocationRepositoryInstructionSources` (`:733-769`) from `agent-workflow.ts:4107` | catalog profile rows plus sandbox reads | **workflow body**: `repositorySources` local at `agent-workflow.ts:4092-4116` | **yes**, as `EffectivePromptRepositorySource[]` (`packages/prompts/effective-prompt.ts:74-91`): repository, path, content, hash, version |
| Description / rules / relationships as **separate fields** | flattened into one string at `repository-instructions.ts:196-207` (`renderRepositoryDescription` `:494-499`, `substitutePromptVariables` `:195`, `renderRelatedRepositories` `:501-515`) | `RepositoryCatalogRules` (`:385-390`) | **inside the step**, `rulesByKey` `:112` | **no.** Showing them as fields needs the step's RETURN value widened (allowed: no identity change), and readers must tolerate the old shape on replay |
| "Selected repositories" in the prompt | `renderSelectedRepositories` `sandbox/context.ts:512-542` | `SelectedRepository[]`, `WorkspaceManifest` | workflow body: `ctx.selectedRepositories`, `ctx.workspaceManifest` | **yes**. Note research passes no `selectedRepositories` and falls back to `repositoryContexts` (`agent-workflow.ts:2830-2837`, `sandbox/context.ts:89`), so the two renderings differ and a briefing should record the one that was used |
| Left-out notes | `renderPreSandboxAdditions` `sandbox/context.ts:497-510` | `PreSandboxPromptAddition[]` (`engine/pre-sandbox/types.ts:89-93`), produced at `repo-selection.ts:252-256` and `:491-500`; discovery-time left-outs pushed at `agent-workflow.ts:2096-2103` | workflow body: `ctx.preSandboxAdditions` (`blocks/prepare-workspace/execute.ts:1207-1208`) | **yes**; the keyed twin `ctx.workScopeLeftOut` (`pre-sandbox/types.ts:57-62`) is carried separately and is *not* what the prompt renders |
| Refusals and "expansion closed" | `agent-workflow.ts:2782-2795` and `:2796-2810` | `expansionRefusals` (local, `:1953`) and `ctx.repositoryExpansion` (`repository-discovery/runner.ts:1011-1025`) | workflow body | **yes** |
| Repository Map | `renderRepositoryMap` `engine/work-scope/map.ts:45` | `RepositoryMap` `:27-31` | nowhere | **no caller outside tests** (confirmed; this is F3 of the plan, stage 6) |

So: everything a briefing needs is in scope in the workflow body at the moment
of the send, with two exceptions that need an existing step's return value
widened (structured catalog description/rules/relationships, and the raw
relationship rows for discovery). Nothing has to be re-read from the catalog at
capture time, which is what the plan requires.

## 6. Clarification deliveries

Every delivery path runs through one plain async function outside the workflow:
`answerClarificationAndResumeWithPersistence`
(`services/clarifications/answer-core.ts:409`). There is **no `"use step"`
anywhere under `services/clarifications/` or `services/work-scope/`**, so none
of these points is journaled and none of them faces a replay question. Callers:
dashboard route (`routes/api/v1/clarifications/[id]/answer.post.ts:32` →
`services/clarifications/answer-request.ts:59-87`), MCP
(`mcp/tools/run-control.ts:304-319`), Jira webhook
(`services/triggers/jira/handle-jira-webhook.ts:559`) and the poll
(`services/triggers/polling/poll-pass.ts:707`), the last two through
`services/clarifications/resume-from-comments.ts:70` and `:472`.

| Delivery | Where to append the row | Notes |
|---|---|---|
| First telling read as unclear | `answer-core.ts:531-614`; the row overwrite is `persistence.recordUnreadable(row.id, answer, answerReading)` `:543` → `db/repositories/clarification-hooks.ts:300-310` | The comment at `:544-560` names exactly the gap this feature closes ("WHAT IS LOST: somebody debugging 'I answered three times and nothing happened' has no record that the words arrived"). The note posted back is composed at `:589-598` and sent at `:604-613` |
| Repeated delivery | same function; `toldBefore` `:500-505` suppresses the re-read and the telling (`:532`, `:578`, `:604`) | The Jira path re-composes the same answer on every poll tick, so this is the common case, and it is the one the record deliberately keeps no trail of |
| Accepted answer | `:637-645` (`persistence.answer`, one CAS `UPDATE`, `clarification-hooks.ts:264-278`), record write at `:713-727` → `services/work-scope/from-answer.ts:455-465` → `applyAnswerWorkScopePlan` (`db/repositories/work-scope.ts:899-933`) | The record write is a single data-modifying CTE (`work-scope.ts:590-633`, reason at `:591-593`: neon-http has no transactions), so a delivery row can be appended as another CTE **only on this path**, and only when `authorship.kind === "write"` (`answer-core.ts:714`) |
| Resume retry | decided at `:420`, branches at `:426-428`, `:531`, `:637-639`, `:694`, `:797-800`; failure classification `:831-849`, `failedResumeOutcome` `:870-883`; driven from `resume-from-comments.ts:119-178` | Records nothing today, so the delivery row is the only trace it would leave |
| The reading | one model read at `:513-521` → `services/clarifications/answer-reading.ts:98-106` → `services/work-scope/read-answer.ts:128-170` | in scope as `answerReading` at every point above |
| The note posted back | `engine/support/clarification-comment-format.ts` (unclear `:609`, accepted `:122`) via `issueTracker.postComment` (`answer-core.ts:606`, `:696-700`, `:806-807`) | a variable at the unclear point; composed inline in the accepted mirror (`:697-700`) and would have to be extracted first. Issue tracker only; **Slack: not found** on this path |

"Asked again after a retry" is an index, not a column:
`work_scope_trail_answer_once` on `(event->>'clarificationId') WHERE kind =
'question_answered'` (`db/schema/work-scopes.ts:117-122`) with
`ON CONFLICT DO NOTHING` (`db/repositories/work-scope.ts:629-630`); the run-level
claim in `resume-from-comments.ts:119-135` short-circuits a duplicate webhook.

Since the unclear branch, the multi-author decline (`from-answer.ts:245-256`)
and the resume retry reach no shared statement, **the delivery insert has to be
its own single statement** rather than a CTE joined to the record write. That is
safe here: this code is not in a workflow, so a second statement is not a
transaction problem, only an ordering one (insert the delivery first, so a
failure later still leaves the trace).

## 7. Recommended capture design

**Per send kind**

| Send | Capture point | What travels | Sequence |
|---|---|---|---|
| Discovery (`agent-workflow.ts:2022`) | new optional argument on `writeAndStartPhase` | kind `discovery`, identity, the offered catalog entries, mandatory repositories, `answerLeftUnnamed`, the relationship sentences as rendered; no compiler sections | its own counter within the enclosing attempt |
| Planning/research, implementation, review (`:2854`, `:3324`, `:3584`) | same argument | kind `agent`, identity, section index from `compilation.sections`, provenance, `unresolvedSources`, the repository context objects listed in §5, and the pass label from `researchPhaseIdentity` | counter per Block Attempt |
| `generic_agent` (`generic-agent/execute.ts:427`), `fix_agent` (`fix-agent/execute.ts:770`) | same argument on their own start steps | as above | counter per Block Attempt |
| `call_llm`, `investigate` | nothing new: prompt, system and schema are already the step's argument object | — | — |

**How the sections reach the send.** `compileInvocationPrompt`
(`agent-workflow.ts:4073-4196`) is created once per invocation inside
`executeV2Block`, so a recorder object created beside it and hung on the
worker-owned `BlockInvocationContext` (`engine/blocks/support/types.ts:415-417`)
is per-invocation and safe against the scheduler's concurrency
(`agent-workflow.ts:4418-4422`). The closure fills it at `:4161-4195` instead of
dropping `compilation`; each send reads it and passes it to its step. The shared
seam `packages/workflow-graph/interpreter.ts:206-216` stays untouched.

**Text, not duplicated.** The step already holds the prompt (`inputContent`)
and the harness extras (`scriptContent`), so the new argument carries only the
index (kind, title, hash, byte length, provenance per section) and the
structured context. Section offsets are derivable, because the prompt is the
sections rendered with sentinels and joined with `\n\n`
(`packages/prompts/effective-prompt.ts:373`, `:713-720`).

**Numbering.** A counter per `(runId, nodeId, attempt, activationScopeId)`
incremented in the workflow body at each send. Deterministic under replay
(the body re-executes the same path), and a replayed step never re-inserts
because its result comes from the journal. Store the four-part identity, not
the attempt row id: the id is a `serial` that never leaves the sink closure
(`agent-workflow.ts:946-960`), while the four-tuple is the row's unique index
(`db/schema/runs.ts:362-367`) and is what the read model should join on.

**Best effort, guaranteed.** The insert lives in a small module modelled on
`engine/work-scope/apply-plans.ts:38-63`: deferred database import inside the
function, one statement (`INSERT … ON CONFLICT (run, node, attempt, scope,
sequence) DO NOTHING`, because neon-http has no transactions), try/catch, a
`logger.warn` with run and attempt so a loss can be found rather than counted,
and no rethrow. Called on the success path of the send step, just before it
returns `{ ok: true, commandId }`, so a briefing exists exactly when an agent
was started; the failure paths already produce a recorded attempt failure, which
is the plan's "the prompt was never sent" reason. The step keeps
`maxRetries = 0` (`phase.ts:552`).

**Redaction.** Inside the step, before the insert, with the same helpers the
replay tabs use (`run-observability/configured-secrets.ts:5`,
`run-observability/sanitizer.ts:316`): `process.env` is available there and the
workflow isolate is the wrong place to read it. Note for the record: the prompt
is already journaled unredacted as a step argument today
(`sandbox/agents/redact.ts:10-12`), so the briefing does not widen that
exposure, and stage 2 should not pretend it fixes it either.

**Files stage 2 will touch**

- `packages/prompts/` — a new pure builder beside `effective-prompt.ts`
  (compilation plus render inputs in, briefing sections and structured context
  out) and its test.
- `apps/worker/src/engine/blocks/support/types.ts` — the per-invocation
  recorder on `BlockInvocationContext` (`:415`).
- `apps/worker/src/engine/agent-workflow.ts` — create the recorder in
  `executeV2Block` (`:4036-4054`), fill it in `compileInvocationPrompt`
  (`:4161-4195`), pass it at the four sends (`:2022`, `:2854`, `:3324`,
  `:3584`), and hand discovery its structured context (`:2004-2021`).
- `apps/worker/src/engine/steps/phase.ts` — one optional trailing parameter on
  `writeAndStartPhase` (`:461-479`) and the best-effort call before `:533`.
- `apps/worker/src/engine/blocks/generic-agent/execute.ts` (`:116`, `:427`) and
  `apps/worker/src/engine/blocks/fix-agent/execute.ts` (`:311`, `:770`) — the
  same parameter and call.
- `apps/worker/src/engine/agent-briefing/` — the capture module, modelled on
  `engine/work-scope/apply-plans.ts`.
- `apps/worker/src/db/schema/` and `apps/worker/drizzle/` — `agent_briefings`
  and `clarification_answer_deliveries`, additive migration (remember
  `build` runs `db:migrate`).
- `apps/worker/src/db/repositories/runs/` — the single-statement inserts.
- `apps/worker/src/services/clarifications/answer-core.ts` — delivery rows at
  `:543`, `:637`, `:713` and on the resume-retry path, plus extracting the
  accepted-answer note into a variable (`:697-700`).
- Optional, decide in stage 2: widen the return value of
  `loadRepositoryInstructionSources` (`engine/steps/repository-instructions.ts:87`)
  so description, rules and relationships arrive as fields rather than one
  string; readers must tolerate the old shape, because a replayed journal
  returns it.
- Guards to run: `engine/step-registration-coverage.test.ts`,
  `engine/workflow-import-boundary.test.ts`.

## 8. Open items and things noticed

1. **Deployment pinning is unproven here.** §3 reads it from the SDK and the
   call sites; nobody has observed it on this production. It decides whether
   case (ii) can happen at all, and it is one cheap check.
2. **`homeFiles` may never be read by the CLI.** The profile home file is
   materialized at `<homeDir>/CLAUDE.md` / `AGENTS.md`
   (`sandbox/harness-runtime.ts:363-380`) while `HOME` is `/tmp/aiw-harness/<hash>/home`
   and the CLIs read `~/.claude/CLAUDE.md` and `$CODEX_HOME/AGENTS.md`. The
   prompt copy (`engine/helpers/effective-prompt.ts:46-65`) is probably what
   lands. Not verified against the CLI docs; worth a ticket of its own, not this
   slice.
3. **Repository instructions reach the model twice** (ours in the prompt, the
   CLI's own discovery from the working tree,
   `harness-profiles/manifest.ts:93-96`). The Briefing page has to say
   that plainly or it will read as the whole context window.
4. **Research and implementation render "Selected repositories" from different
   input objects** (`agent-workflow.ts:2830-2837` versus `:3294-3305`). Recording
   what was rendered will make that visible; fixing it is not stage 2's job.
5. **Discovery runs on the legacy, unpinned harness path**
   (`agent-workflow.ts:1967-1971`, `engine/blocks/agent-sandbox.ts:180`): no
   profile, no `--effort`, no `--disallowedTools`. A discovery briefing must not
   claim profile values it never had.
