Status: current
Last-verified: 2026-09-09

# Delivery gates

This document defines how repository work is identified, verified, evidenced,
closed, deployed, and released. It does not override explicit instructions and
grants no Jira, merge, sync, deployment, tenant, smoke-test, release, or
rollback authority.

Read it when preparing evidence, closing a ticket, or working on a release. The
rules that bind ordinary edits are inlined in [`AGENTS.md`](../AGENTS.md)
instead, so that this file does not need to be loaded on every session.

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

### In force

These gates are executable today and produce evidence an agent can cite.

| Gate | Required contract |
| --- | --- |
| **G0 — clean task/source freeze** | Confirm the recorded worktree, branch/upstream, start SHA, clean state, Jira scope, and target environment/tenant before edits. Stop on an unexplained mismatch or unrelated dirty state. |
| **G1 — fast local pre-push** | Run `pnpm run verify:changed` plus any ticket-specific reproducer not selected by that scope-aware gate. This gate is advisory and bypassable; record every skip, bypass, or failure honestly. Local hooks are never authoritative. |
| **G2 — PR CI** | The candidate must pass the full PR CI run. A repository ruleset on `main` requires the `ci` aggregator before merge, so a red `ci` blocks the merge. The only bypass is one named user account, and every use of it must open a Jira issue recording what was merged and why; that audit is not itself machinery-checked. |
| **G4 — per-ticket evidence** | Map each ticket's acceptance criteria to its reproduction, exact commands and outcomes, CI, candidate/merge SHA, and residual risk. Do not use another ticket's evidence as a substitute. |

### Not enforced by machinery

These describe intent, not a net that exists. Do not cite them as if a system
checked them for you.

| Gate | Status |
| --- | --- |
| **G3 — candidate E2E** | The E2E suites run nightly and on dispatch from [`e2e.yml`](../.github/workflows/e2e.yml); they are no longer duplicated into `ci.yml` behind `merge_group`, which cannot fire while no merge queue is configured. Each tier now preflights `scripts/ci/verify-deployment-identity.ts`, which refuses unless the deployment reports the same database-branch fingerprint the tests connect to, and unless it serves the named candidate when a dispatch names one. G3 stays `BLOCKED` until an actual run produces that evidence: the machinery existing is not the evidence, and a configured E2E run passing is not either. |
| **G5 — isolated deployment verification** | Policy, separately authorized each time. With that authorization, deploy the exact SHA only to the named isolated environment/tenant, prove deployment identity, run authenticated smoke and required tenant reruns, capture runtime/smoke IDs, and verify cleanup. |
| **G6 — release or rollback approval** | Policy, separately authorized each time. Release and rollback are decisions separate from implementation and verification. Record the approved candidate or rollback baseline and the result; this document defines no deployment or rollback procedure. |

### Enforcement limits

External G2 enforcement runs through a repository ruleset on `main` (id
22668605, "main requires ci"), not classic branch protection: one
`required_status_checks` rule naming `ci`, strict policy off, and one
`bypass_actors` entry (a `User`, always mode) for the repository owner's
account, with no role-based exemption. GitHub enforces the required check and
the bypass allowlist; it does not enforce that a bypass records why. The Jira
issue for each bypass use is a human-enforced rule, so verify it was actually
opened rather than assume the policy was followed.

Dated documents that describe CI as informational remain historical context.

## Local baseline

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

`deployment.identity_proof` comes from the worker's `/health`. Record its exact
`commit`, `env`, `databaseEnv`, and `databaseFingerprint`; together they prove
which candidate the endpoint serves and which isolated database branch it uses.
The completed settings migration fields are no longer part of `/health`.
Retired settings variables are instead refused at build and runtime boot; see
SETUP.md, section "Removing migrated environment variables".

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
remain separately authorized. This document grants none of them. An actual
rollback requires Filip's explicit decision.

Operate only in the recorded environment and tenant. Keep fixtures, credentials,
runtime IDs, Jira issues, branches/PRs, schedules, and database effects inside
that boundary; record and verify cleanup before G5 can pass.

## Authoritative repository references

- Commands: [root package scripts](../package.json) and
  [worker package scripts](../apps/worker/package.json).
- CI and E2E: [source gate](../.github/workflows/ci.yml) and
  [nightly and manual E2E](../.github/workflows/e2e.yml).
- Artur release: [release runbook](releases/artur/README.md),
  [upgrade preflight](releases/artur/upgrade-preflight.md), and
  [rehearsal runbook](releases/artur/rehearsals/README.md).
- Jira transitions: [product specification](product/SPEC.md) and
  [the workflow definition reference](architecture/workflow-definition.md).
  The older runtime block reference is archived at
  [archive/testing/block-reference.md](archive/testing/block-reference.md): it
  predates several block types and is history, not a source of truth.
- Scope: [roadmap](product/roadmap-2026-08-27.md).
- Evidence from past campaigns, archived and dated:
  [production evidence plan](archive/testing/production-mcp-stress-test-plan.md),
  [E2E test plan](archive/testing/e2e-workflow-test-plan.md), and
  [evidence index](archive/testing/evidence/README.md).
