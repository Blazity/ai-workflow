# Workflow definitions

The orchestration MVP models each automation as a directed graph of typed blocks. A definition is a `schemaVersion: 1` object with `nodes` and `edges`; the shared schema validates node shapes and `validateWorkflowGraph` enforces the structural rules (single trigger per type, no fan-out from one port, reachability, loop and branch wiring, condition scoping).

This document describes the four canonical definitions that ship as fixtures in `apps/worker/src/workflow-definition/graph-fixtures.ts`. Each is validated in `schema.test.ts` to produce zero issues.

Notation: `A -> B` is a default-port edge. `A --port--> B` names the source port (branch `true`/`false`, loop `continue`/`exhausted`). Blocks list only the params they set; everything else uses schema defaults.

---

## V1 - Standard delivery (linear default)

The recommended default: a straight chain with no fan-out. Fixture: `linearPipelineDefinition()`.

Nodes:

- `trigger` : `trigger_ticket_ai`
- `planning` : `planning_agent`
- `implementation` : `implementation_agent`
- `checks` : `run_pre_pr_checks`
- `open-pr` : `open_pr`
- `status` : `update_ticket_status` (params: `target: "ai_review"`)
- `slack` : `send_slack_message`

Edges:

```
trigger -> planning -> implementation -> checks -> open-pr -> status -> slack
```

---

## V2 - Branch and loop (human gate)

Exercises a branch gate, a terminate leaf, and a re-entrant fix loop. Fixture: `humanGateLoopDefinition()` (the in-loop fix agent defaults to `review_agent` as a stand-in).

Nodes:

- `trigger` : `trigger_ticket_ai`
- `planning` : `planning_agent`
- `gate` : `branch` (params: `condition: steps.planning.output.status == "needs_human_input"`)
- `notify` : `send_slack_message`
- `halt` : `terminate` (params: `terminalStatus: "waiting_for_human"`)
- `implementation` : `implementation_agent`
- `checks` : `run_pre_pr_checks`
- `verdict` : `branch` (params: `condition: steps.checks.output.ok`)
- `open-pr` : `open_pr`
- `retry` : `loop` (params: `maxAttempts: 3`, `onExhaust: "fail"`)
- `fix` : `review_agent`

Edges:

```
trigger -> planning -> gate
gate --true--> notify -> halt
gate --false--> implementation -> checks -> verdict
verdict --true--> open-pr
verdict --false--> retry --continue--> fix -> checks
```

The `retry` loop's `continue` port leads back to `checks`, so the fix cycle re-enters the checks stage until the verdict passes or the loop exhausts.

---

## V3 - Plan approval

A plan-approval hand-off split across two triggers in one definition. The first chain plans and requests approval; the second chain re-enters when the plan is approved and delivers. Fixture: `planApprovalDefinition()`.

`send_plan_approval` is a terminal block (no outgoing ports): the run ends there, and the dashboard approval later fires `trigger_plan_approved` to start the delivery chain.

Nodes:

- `trigger-ticket` : `trigger_ticket_ai`
- `planning` : `planning_agent`
- `send-approval` : `send_plan_approval`
- `trigger-approved` : `trigger_plan_approved` (default `source: "dashboard"`)
- `implementation` : `implementation_agent`
- `open-pr` : `open_pr`
- `status` : `update_ticket_status` (params: `target: "ai_review"`)

Edges:

```
trigger-ticket -> planning -> send-approval
trigger-approved -> implementation -> open-pr -> status
```

---

## V4 - PR fix (two triggers, one pipeline)

Two PR triggers fan into a single shared fix-and-comment pipeline. Both `trigger_pr_checks_failed` and `trigger_pr_review` wire into one `fetch_pr_context` node. The validator allows unbounded in-degree, so two triggers may point at the same node. Fixture: `prReviewFixDefinition()`.

Nodes:

- `trigger-checks-failed` : `trigger_pr_checks_failed`
- `trigger-review` : `trigger_pr_review`
- `fetch-context` : `fetch_pr_context`
- `prepare` : `prepare_workspace`
- `fix` : `fix_agent`
- `finalize` : `finalize_workspace`
- `comment` : `post_pr_comment` (params: `body: "Automated fix pushed. Please re-review."`)

Edges:

```
trigger-checks-failed -> fetch-context
trigger-review        -> fetch-context
fetch-context -> prepare -> fix -> finalize -> comment
```

---

## Deprecation of the in-repo YAML pipelines

Workflow definitions are the single source of truth for run behavior. The two in-repo YAML pipelines are deprecated because their work is now expressed as blocks inside definitions:

- **`pre-sandbox.yaml`** selected repositories before the sandbox started. The `prepare_workspace` block now absorbs pre-sandbox repo selection: its executor calls the pre-sandbox phase with the loaded config, and repo selection is materialized as part of workspace preparation.
- **`post-pr-gate.yaml`** ran a detached gate on bot PRs. PR-trigger definitions now absorb the gate: a matched, enabled definition on a bot PR supersedes it (gate precedence). Non-bot PRs and PRs with no matching definition still fall through to the gate.

Both files are now **optional**:

- When a file is absent, the loader returns a built-in default equal to the previously shipped YAML. `loadPreSandboxConfig` defaults to one `repo-selection` step (`onFailure: fail`, `timeoutMs: 60000`). `loadPostPrGateConfig` defaults to `runOn` `{ botPrsOnly: true, draftPrs: false, baseBranches: [] }` with one `code-hygiene` step (`onFailure: continue`, `timeoutMs: 180000`).
- When a file is present and its content differs from the built-in default, the loader logs a deprecation warning on load (`pre_sandbox_yaml_deprecated` / `post_pr_gate_yaml_deprecated`) and still loads it. Schema validation is unchanged.
- The Nitro build ships whichever YAML files are committed and never fails when one is missing.

Additionally, when a gate run starts and at least one enabled definition declares any of the three PR trigger types (`trigger_pr_created`, `trigger_pr_checks_failed`, `trigger_pr_review`), the dispatcher logs `post_pr_gate_deprecated` once for that run, signaling that a definition now covers the same PRs.
