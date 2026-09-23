Status: current
Last-verified: 2026-09-23

# Documentation index

This file is the only list of current documents. If a document is not here, it
is either an artifact (see the last section), a journal in `archive/`, or it
should not be trusted.

Every document outside `archive/` and `research/` starts with two lines,
`Status:` and `Last-verified:`. The rules and the reasoning are
[ADR-005](./adr/ADR-005-documentation-taxonomy.md), and
`scripts/gates/docs-status.mjs` enforces them over `docs/`, `apps/*/docs/`,
each `apps/*/AGENTS.md`, `packages/AGENTS.md`, and `README.md`, `AGENTS.md`,
`SETUP.md` and `CONTEXT.md` at the root. Those paths are required rather than
opportunistic: when one of them moves the gate refuses, instead of quietly
checking the smaller set that is left (ADR-007).

## Start here

| Document | What it is for |
|---|---|
| [README.md](../README.md) | What the product is, what works today, and what is planned |
| [AGENTS.md](../AGENTS.md) | Routing table: which document to open for the work at hand, plus the rules that bind every edit |
| [DESIGN.md](../DESIGN.md) | Dashboard cockpit visual language, tokens, shared primitive rules, layout, depth, and current gaps |
| [SETUP.md](../SETUP.md) | Reference facts for setting up and deploying: accounts, environment variables, webhooks, smoke tests |
| [CONTEXT.md](../CONTEXT.md) | Glossary. What a block, a run, a definition and a trigger mean here |
| [delivery-gates.md](./delivery-gates.md) | How work is identified, verified, evidenced, closed, deployed and released |

## Architecture

| Document | What it is for |
|---|---|
| [architecture/workflow-definition.md](./architecture/workflow-definition.md) | The definition schema v2: nodes, edges, bindings, triggers, harness profiles, loops, validation, deployment, the MCP authoring surface |
| [architecture/repository-scripts.md](./architecture/repository-scripts.md) | The repository scripts config contract: named command groups, how a block selects them |
| [architecture/blocks.md](./architecture/blocks.md) | How block manifests, executor modules, generated catalogs, and the reviewer walkthrough fit together |
| [architecture/integrations.md](./architecture/integrations.md) | Writing an integration from nothing to connected: capabilities, the connection and its pin, health checks, blocks, webhooks, pages, testing without production credentials, and what breaks if you do what it says not to |
| [architecture/skills.md](./architecture/skills.md) | Product skill manifests, artifact integrity, source boundaries, and the repository-root `skills/` convention |
| [architecture/overview.md](./architecture/overview.md) | The `services/` tier: what each cluster owns, what it may import, and what its `index.ts` promises |
| [architecture/data-model.md](./architecture/data-model.md) | The worker's 75 SQL tables, ownership and principal callers |
| [architecture/gates.md](./architecture/gates.md) | The delivery gate ladder, lint policy, and the stage 11 ratchets |

## Decision records

| Document | What it is for |
|---|---|
| [adr/README.md](./adr/README.md) | What an ADR is here, when to write one, the numbering rules, and the index |
| [adr/ADR-001-layering-and-packages.md](./adr/ADR-001-layering-and-packages.md) | The worker's tiers, the allowed edges between them, and which package holds what |
| [adr/ADR-002-block-manifest.md](./adr/ADR-002-block-manifest.md) | One directory per block, a pure manifest, three generated files |
| [adr/ADR-003-definition-schema-v1-retirement.md](./adr/ADR-003-definition-schema-v1-retirement.md) | Why schema v1 is retired, what is deleted, and what stays readable |
| [adr/ADR-004-gates-and-required-ci.md](./adr/ADR-004-gates-and-required-ci.md) | The gate ladder, one shape per gate, and what has to be true before a check can be required |
| [adr/ADR-005-documentation-taxonomy.md](./adr/ADR-005-documentation-taxonomy.md) | This taxonomy: the status header, the currency rule, the reachability rule, per-app agent files |
| [adr/ADR-006-model-catalog.md](./adr/ADR-006-model-catalog.md) | The recognised model policy, live-advertisement intersection, stored-ID compatibility, and catalog ownership |
| [adr/ADR-007-empty-scan-is-a-refusal.md](./adr/ADR-007-empty-scan-is-a-refusal.md) | Why a gate that scanned nothing refuses instead of passing, the two helpers that refuse, and the one gate that cannot |
| [adr/ADR-008-claims-the-code-owns.md](./adr/ADR-008-claims-the-code-owns.md) | When a document may restate a list the code owns, and the test that holds the copy level in both directions |
| [adr/ADR-009-agent-instruction-layers.md](./adr/ADR-009-agent-instruction-layers.md) | Where agent instructions live (router, per-area files, path-scoped rules, archive) and the byte ceilings a hook warns about |
| [adr/ADR-010-integrations.md](./adr/ADR-010-integrations.md) | What an integration is and what it receives: the package layout, the capability ports, the context, connection sources, the conformance check, the inventory it was designed from, and the change log of the SDK |

## Product

| Document | What it is for |
|---|---|
| [product/SPEC.md](./product/SPEC.md) | What the system does: behaviour, states, ticket lifecycle, delivery rules |
| [product/user-stories.md](./product/user-stories.md) | The user stories the behaviour is measured against |
| [product/repository-record-behaviour.md](./product/repository-record-behaviour.md) | What a person may do about which repositories a piece of work touches, and what the system must do in every case, including the ones nobody wants to think about |
| [product/roadmap-2026-08-27.md](./product/roadmap-2026-08-27.md) | Priorities and milestones. It beats the README wherever the two disagree |

## Runbooks

| Document | What it is for |
|---|---|
| [runbooks/GITHUB-APP-SETUP.md](./runbooks/GITHUB-APP-SETUP.md) | Creating and installing the GitHub App, and the events it subscribes to |
| [runbooks/GITLAB-SETUP.md](./runbooks/GITLAB-SETUP.md) | Setting up a GitLab project, its token and its webhook |
| [runbooks/agent-runtime-diagnostics.md](./runbooks/agent-runtime-diagnostics.md) | Turning a diagnostic ID from a failed run into the provider detail in the worker log |
| [runbooks/reading-an-agent-briefing.md](./runbooks/reading-an-agent-briefing.md) | Draft: where to see what an agent was sent, on each surface, and what an empty answer means |
| [runbooks/ON-PREM-AWS.md](./runbooks/ON-PREM-AWS.md) | Draft proposal for a self-hosted AWS deployment. Not implemented, and it predates the move to Neon Postgres |
| [releases/artur/README.md](./releases/artur/README.md) | The Artur release contract: the two pull request flow, from preparation to the published tag |
| [releases/artur/upgrade-preflight.md](./releases/artur/upgrade-preflight.md) | The tenant database check that has to pass before a release pull request merges |
| [releases/artur/rehearsals/README.md](./releases/artur/rehearsals/README.md) | How to rehearse a pinned source commit and record the result the sync requires |

## Quality

| Document | What it is for |
|---|---|
| [qa/repository-catalog-matrix.md](./qa/repository-catalog-matrix.md) | The repository catalog's 143 scenarios and the automated test holding each one, with the rows nobody pins yet |
| [qa/settings-enforcement-matrix.md](./qa/settings-enforcement-matrix.md) | Production evidence for settings resolution, run-start freezing, capacity enforcement, feature flags, and MCP limits |
| [qa/integrations-scenarios.md](./qa/integrations-scenarios.md) | Draft: the integrations user journeys and edge cases, the rules for deriving tests from them, and which test holds each scenario |

## Research

Measurements and primary-source notes. They are dated and never restamped: a
research file records what was true on its date.

| Document | What it is for |
|---|---|
| [research/2026-09-18-agent-briefing-capture-path.md](./research/2026-09-18-agent-briefing-capture-path.md) | Where every prompt is sent from, and how a briefing can be recorded without a new step or a drain |
| [research/2026-09-09-architecture-audit.md](./research/2026-09-09-architecture-audit.md) | Current state of the codebase, measured: cycles, tiers, gates, documentation inventory, target shape |
| [research/2026-09-09-agent-navigable-codebase.md](./research/2026-09-09-agent-navigable-codebase.md) | What Anthropic publishes about how agents load a codebase, with the hard rules separated from the recommendations |
| [research/2026-09-09-monorepo-boundary-enforcement.md](./research/2026-09-09-monorepo-boundary-enforcement.md) | How boundaries can be enforced here, and what Nitro and the Workflow DevKit constrain |
| [research/2026-09-09-roadmap-backlog-fit.md](./research/2026-09-09-roadmap-backlog-fit.md) | How the restructure plan fits the product roadmap and the open backlog |
| [research/2026-08-12-arthur-engine-scope-and-evals.md](./research/2026-08-12-arthur-engine-scope-and-evals.md) | Scope of the Arthur Engine integration and its evaluation surface |
| [research/2026-08-12-workflow-guardrails.md](./research/2026-08-12-workflow-guardrails.md) | Design study for enforceable guardrails on high-risk actions |
| [research/2026-07-21-agent-memory-systems.md](./research/2026-07-21-agent-memory-systems.md) | Prior art for the agent memory feature |

## Plans

| Document | What it is for |
|---|---|
| [plans/2026-09-09-architecture-restructure.md](./plans/2026-09-09-architecture-restructure.md) | Delivered 2026-09-09 to 2026-09-13: architecture restructure stages, decisions, assumptions, freezes, and delivery record |
| [plans/2026-09-09-architecture-restructure-tickets.md](./plans/2026-09-09-architecture-restructure-tickets.md) | The Jira drafts for those stages |
| [plans/2026-09-11-workflow-graph-package.md](./plans/2026-09-11-workflow-graph-package.md) | Stage 12 of the restructure: the workflow graph rules extracted into `packages/workflow-graph` |
| [plans/2026-09-14-run-capacity-package.md](./plans/2026-09-14-run-capacity-package.md) | First P0 package after the restructure: MCP manual dispatch honours the capacity limit (AIW-373, AIW-385) and AIW-277 closes with production evidence |
| [plans/2026-09-14-p0-run-completion-and-planning.md](./plans/2026-09-14-p0-run-completion-and-planning.md) | Second P0 package after the restructure: completion fields at the status flip with an honest `runs.result` (AIW-369) and the planning expansion loop on an already-attached repository (AIW-377) |
| [plans/2026-09-11-repository-catalog-and-settings.md](./plans/2026-09-11-repository-catalog-and-settings.md) | Delivered 2026-09-11 to 2026-09-13: repository catalog and dashboard settings replacing the product-behaviour environment variables |
| [plans/2026-09-14-product-changelog.md](./plans/2026-09-14-product-changelog.md) | The product changelog: an entry folder authors fill per pull request, a daily collation workflow, and the CI check that a product change carries an entry |
| [plans/2026-09-15-repository-work-scope.md](./plans/2026-09-15-repository-work-scope.md) | Draft, in delivery: one durable record per subject of work for which repositories it touches, a repository policy per trigger, a decision trail readable through MCP, and a repository map in the agent's prompt (AIW-402, AIW-377, roadmap P1 repository scope per trigger) |
| [plans/2026-09-18-integrations.md](./plans/2026-09-18-integrations.md) | Draft: every third party (Arthur, Slack, GitHub, GitLab, Jira) as one package under `integrations/` that unlocks blocks, screens, health checks and MCP tools once connected; memory as a capability; the guide for writing a new integration (AIW-395, AIW-394, AIW-396, roadmap P3) |
| [plans/2026-09-22-integrations-hardening.md](./plans/2026-09-22-integrations-hardening.md) | Draft: the round between S14 and S15 of the integrations plan: every finding of the whole-branch review with its outcome, and the decisions it forced (adapter lifetime, memory budget, one home for secrets, trigger parameters and connection verdicts, the memory contract before Mem0) |
| [plans/2026-09-19-agent-visibility.md](./plans/2026-09-19-agent-visibility.md) | Draft, in delivery: record and show exactly what every agent send was given (Agent Briefing, Clarification Rounds) in the dashboard and MCP, prompt runtime text as named parts with origin, and the Repository Map wired into every repository-working prompt |

Every other file in `plans/` is a historical delivery plan. It stays in place
for provenance and carries `superseded-by docs/index.md`: read it as a record
of what was decided on its date, never as a description of the code today.

## Archive

`archive/` holds what happened, not what is true. Nothing is deleted from it,
so links into it keep resolving.

| Folder | What is in it |
|---|---|
| [archive/qa/](./archive/qa/) | Dated QA sessions, production stress test findings, the QA playbook |
| [archive/testing/](./archive/testing/) | E2E findings and reports, test and stress plans, canary notes, the older block reference |
| [archive/superpowers/](./archive/superpowers/) | The plan and design notes of the superpowers era, from all three trees (`docs/`, `apps/worker/docs/`, `apps/dashboard/docs/`) |
| [archive/assumptions/](./archive/assumptions/) | The abandoned assumption ledger |
| [archive/dashboard/](./archive/dashboard/) | The dashboard overview API requirements, whose `lib/integrations/*` architecture was never built |
| [archive/post-pr-gate-spec.md](./archive/post-pr-gate-spec.md) | The specification of the legacy post-PR gate, neutralized in AIW-220 |
| [archive/pre-sandbox-plan.md](./archive/pre-sandbox-plan.md) | The pre-sandbox phase plan, now absorbed by the workspace blocks |
| [archive/SECURUTY-OBSERVABILITY.md](./archive/SECURUTY-OBSERVABILITY.md) | An early security and observability note |
| [archive/design-qa.md](./archive/design-qa.md) | The AIW-179 visual QA session and its verdict |
| [archive/learnings.md](./archive/learnings.md) | The session learnings file, mined into `.claude/rules/*.md` and the root `AGENTS.md` |
| [archive/agent-notes/](./archive/agent-notes/) | History and reasoning moved out of the `AGENTS.md` files and `.claude/rules/*.md` on 2026-09-17, one file per area |

## Artifacts, not documents

These carry their own required first lines and their own consumers, so they
have no status header and the docs gate skips them.

| Artifact | Consumer |
|---|---|
| `docs/releases/artur/YYYY.MM.PATCH.md` | The release pipeline copies the reviewed note into the tenant repository |
| `docs/example-skill/SKILL.md` | The example agent skill referenced from SETUP.md |
| `docs/example-workflows/loop-branch-workflow.json` | An importable example definition |
| `CHANGELOG.md` | The daily collation workflow (`.github/workflows/changelog.yml`) writes one `vYYYY.MM.N` section per release; readers consume it directly, and the release job renders the GitHub Release from the newest section (`changelog/README.md`, Releases) |
| `changelog/unreleased/*.md` | The daily collation workflow reads and deletes them; the CI completeness check (`scripts/ci/changelog-entry-gate.ts`) reads them too, to see whether a pull request's entry yields a bullet |
