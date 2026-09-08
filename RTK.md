# Repository trust contract

This contract defines how repository work is identified, verified, evidenced,
closed, deployed, and released. It augments `AGENTS.md` and `CLAUDE.md`; it does
not override explicit instructions or grant Jira, merge, sync, deployment,
tenant, smoke-test, release, or rollback authority.

## Freeze identity and state

Before editing, record an immutable task/source identity:

- absolute worktree path;
- branch and upstream, or an explicit `none`;
- exact 40-character start SHA and clean-state result, including any known
  pre-existing changes and their owner;
- Jira ticket(s), bounded scope, and acceptance criteria;
- target environment and tenant, or an explicit `none`.

Before verification, freeze the exact 40-character candidate SHA. After merge
or deployment, add the exact merge and deployed SHAs. Never substitute a branch,
tag, alias, deployment URL, or abbreviated SHA. If the candidate or target
changes, start a new evidence bundle and retain the superseded one.

Track two independent axes; never infer one from the other:

- delivery state: `planned`, `in_progress`, `implemented`, `merged`, `deployed`;
- evidence verdict: `NOT_RUN`, `IN_VERIFICATION`, `PASS`, `FAIL`, `BLOCKED`.

## Gate ladder

The gates are cumulative. A later result does not erase an earlier `FAIL` or
`BLOCKED`, and missing evidence is never a `PASS`.

| Gate | Required contract |
| --- | --- |
| **G0 — clean task/source freeze** | Confirm the recorded worktree, branch/upstream, start SHA, clean state, Jira scope, and target environment/tenant before edits. Stop on an unexplained mismatch or unrelated dirty state. |
| **G1 — fast local pre-push** | Run `pnpm run verify:changed` plus any ticket-specific reproducer not selected by that scope-aware gate. This gate is advisory and bypassable; record every skip, bypass, or failure honestly. Local hooks are never authoritative. |
| **G2 — authoritative PR CI** | The candidate must pass the full PR CI run. Nothing enforces this at merge time, so a green run is evidence of correctness and never proof that a red candidate could not land. |
| **G3 — merge-group candidate E2E** | Run E2E against the exact merge-group candidate only after proving that the deployment serves that candidate and uses the identified database. |
| **G4 — per-ticket evidence** | Map each ticket's acceptance criteria to its reproduction, exact commands and outcomes, CI, candidate/merge SHA, and residual risk. Do not use another ticket's evidence as a substitute. |
| **G5 — isolated deployment verification** | With separate authorization, deploy the exact SHA only to the named isolated environment/tenant, prove deployment identity, run authenticated smoke and required tenant reruns, capture runtime/smoke IDs, and verify cleanup. |
| **G6 — release or rollback approval** | Treat release and rollback as decisions separate from implementation and verification. Record the approved candidate or rollback baseline and the result; this contract defines no deployment or rollback procedure. |

### Honest local baseline

Choose the commands applicable to the changed surface and record the exact
command, outcome, and any reason for not running it:

```sh
git diff --check
pnpm run typecheck
(cd apps/worker && pnpm run validate:pre-sandbox)
(cd apps/worker && pnpm run validate:local-skills)
(cd apps/worker && pnpm run mcp:contract:check)
pnpm run test:ci
```

Also run the smallest focused test that reproduces the issue, then changed-area
and nearby regression tests as warranted. Root `pnpm test` and `pnpm build` are
not mandatory local defaults; broad/full suites belong in CI unless the task or
an explicit instruction requires them.

The scope-aware G1 entry point is:

```sh
pnpm run verify:changed -- --base origin/main
```

The explicit base is optional. Without it, the command resolves the first local
commit available in this order: the branch upstream, `origin/HEAD`, then
`origin/main`. It never fetches. Before enabling the native hook, first inspect:

```sh
git config --local --get core.hooksPath
```

- If the result is empty, enable it with
  `git config --local core.hooksPath .githooks`.
- If the result is exactly `.githooks`, no change is needed.
- For any other value, stop and do not overwrite the existing hook path.

The hook delegates to `pnpm run verify:changed` and checks the current `HEAD`.
It does not interpret arbitrary or multi-ref pre-push stdin; G2 remains the
authority for the actual target branch and candidate. `git push --no-verify`
remains an advisory, audited bypass: record why it was used and do not report G1
as a pass. Changes under `docs/releases/` select the release-notes typecheck and
test suite, but that suite does not validate the exact release artifact. G1 does
not replace ticket-specific evidence in G4 or live, isolated deployment evidence
in G5, and no local hook is authoritative G2 evidence.

### Current enforcement limits

This is the desired current gate contract. Dated documents that describe CI as
informational remain historical context. External G2 enforcement is `BLOCKED`
by a deliberate waiver: branch protection on `main` was declined as delivery
policy, not deferred pending setup. The observed state is `main.protected=false`
with no rulesets, so do not claim that branch protection or required-check
enforcement exists, and do not open work to configure it without a new decision.
G2 evidence is the PR CI run itself, which nothing enforces at merge time.

The merge-group E2E jobs exist, but G3 cannot be authoritative until evidence
proves both that the endpoint serves the exact candidate SHA and that the
deployment and E2E database belong together. Until then, record the authority
of G3 as `BLOCKED`, even if a configured E2E run passes.

## Evidence bundle

Use one bundle per ticket and immutable candidate. Use `null` plus a reason for
fields that do not yet apply; do not silently omit them. Timestamps are UTC.

```yaml
ticket_scope: "KEY: bounded scope and acceptance criteria"
timestamps: { started_at: null, verified_at: null }
worktree: { path: null, branch: null, upstream: null, clean_state: null }
start_sha: null
candidate_sha: null
merge_sha: null
deployed_sha: null
changed_files_pr: { files: [], pr: null }
reproduction: { before: null, after: null }
checks:
  - { command: null, outcome: null, evidence: null }
ci_url: null
deployment: { identity_proof: null, environment: null, tenant: null }
runtime_smoke_ids: []
cleanup: { artifacts: [], result: null }
rollback: { baseline_sha: null, result: null }
delivery_state: planned
verdict: NOT_RUN
residual_risk: null
redaction: "secrets, tokens, credentials, customer data, and unnecessary PII removed"
```

## Jira disposition

Use only these actions: `keep`, `update`, `link duplicate/merge`, `close-done`,
`close-obsolete`, or `blocked`. Deletion is never the default. Preserve lineage
when linking duplicates or merged scope, and state the reason for obsolete or
blocked work.

Only an authorized actor may mutate Jira. `close-done` requires ticket-scoped
evidence for the exact merged SHA and, when acceptance criteria require it, the
exact deployed SHA plus environment/tenant evidence. Pending, skipped, stale,
`NOT_RUN`, `IN_VERIFICATION`, `FAIL`, or `BLOCKED` evidence cannot close a ticket.
A merge or delivery-state label alone is insufficient. Record newly discovered
defects as separate Jira issues instead of silently widening the current slice.

## Authorization and isolation

Authorization for one action never implies another. Artur or customer sync,
merge, deployment, authenticated smoke, tenant rerun, release, and rollback each
remain separately authorized. This contract grants none of them. An actual
rollback requires Filip's explicit decision.

Operate only in the recorded environment and tenant. Keep fixtures, credentials,
runtime IDs, Jira issues, branches/PRs, schedules, and database effects inside
that boundary; record and verify cleanup before G5 can pass.

## Authoritative repository references

- Commands: [root package scripts](package.json) and
  [worker package scripts](apps/worker/package.json).
- CI and E2E: [PR/merge-group CI](.github/workflows/ci.yml) and
  [manual E2E](.github/workflows/e2e.yml).
- Artur release: [release runbook](docs/releases/artur/README.md),
  [upgrade preflight](docs/releases/artur/upgrade-preflight.md), and
  [rehearsal runbook](docs/releases/artur/rehearsals/README.md).
- Jira transitions: [product specification](docs/SPEC.md) and
  [runtime block reference](docs/testing/block-reference.md).
- Scope and evidence: [roadmap](docs/AI-WORKFLOW-ROADMAP.md),
  [production evidence plan](docs/testing/production-mcp-stress-test-plan.md),
  [E2E test plan](docs/testing/e2e-workflow-test-plan.md), and
  [evidence index](docs/testing/evidence/README.md).
