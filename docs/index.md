Status: current
Last-verified: 2026-09-09

# Documentation index

This file is the only list of current documents. If a document is not here, it
is either an artifact (see the last section), a journal in `archive/`, or it
should not be trusted.

Every document outside `archive/` and `research/` starts with two lines,
`Status:` and `Last-verified:`. The rules and the reasoning are
[ADR-005](./adr/ADR-005-documentation-taxonomy.md), and
`scripts/gates/docs-status.mjs` enforces them over `docs/`, `apps/*/docs/`,
each `apps/*/AGENTS.md`, and `README.md`, `AGENTS.md`, `SETUP.md` and
`CONTEXT.md` at the root.

## Start here

| Document | What it is for |
|---|---|
| [README.md](../README.md) | What the product is, what works today, and what is planned |
| [AGENTS.md](../AGENTS.md) | Routing table: which document to open for the work at hand, plus the rules that bind every edit |
| [SETUP.md](../SETUP.md) | Reference facts for setting up and deploying: accounts, environment variables, webhooks, smoke tests |
| [CONTEXT.md](../CONTEXT.md) | Glossary. What a block, a run, a definition and a trigger mean here |
| [delivery-gates.md](./delivery-gates.md) | How work is identified, verified, evidenced, closed, deployed and released |

## Architecture

| Document | What it is for |
|---|---|
| [architecture/workflow-definition.md](./architecture/workflow-definition.md) | The definition schema v2: nodes, edges, bindings, triggers, harness profiles, loops, validation, deployment, the MCP authoring surface |
| [architecture/repository-scripts.md](./architecture/repository-scripts.md) | The repository scripts config contract: named command groups, how a block selects them |
| [architecture/blocks.md](./architecture/blocks.md) | How block manifests, executor modules, generated catalogs, and the reviewer walkthrough fit together |
| [architecture/skills.md](./architecture/skills.md) | Product skill manifests, artifact integrity, source boundaries, and the repository-root `skills/` convention |

Stage 4 and later stages of the restructure plan add `architecture/blocks.md`,
`architecture/overview.md`, `architecture/data-model.md` and
`architecture/gates.md` to this group.

## Decision records

| Document | What it is for |
|---|---|
| [adr/README.md](./adr/README.md) | What an ADR is here, when to write one, the numbering rules, and the index |
| [adr/ADR-001-layering-and-packages.md](./adr/ADR-001-layering-and-packages.md) | The worker's tiers, the allowed edges between them, and which package holds what |
| [adr/ADR-002-block-manifest.md](./adr/ADR-002-block-manifest.md) | One directory per block, a pure manifest, three generated files |
| [adr/ADR-003-definition-schema-v1-retirement.md](./adr/ADR-003-definition-schema-v1-retirement.md) | Why schema v1 is retired, what is deleted, and what stays readable |
| [adr/ADR-004-gates-and-required-ci.md](./adr/ADR-004-gates-and-required-ci.md) | The gate ladder, one shape per gate, and what has to be true before a check can be required |
| [adr/ADR-005-documentation-taxonomy.md](./adr/ADR-005-documentation-taxonomy.md) | This taxonomy: the status header, the currency rule, the reachability rule, per-app agent files |

## Product

| Document | What it is for |
|---|---|
| [product/SPEC.md](./product/SPEC.md) | What the system does: behaviour, states, ticket lifecycle, delivery rules |
| [product/user-stories.md](./product/user-stories.md) | The user stories the behaviour is measured against |
| [product/roadmap-2026-08-27.md](./product/roadmap-2026-08-27.md) | Priorities and milestones. It beats the README wherever the two disagree |

## Runbooks

| Document | What it is for |
|---|---|
| [runbooks/GITHUB-APP-SETUP.md](./runbooks/GITHUB-APP-SETUP.md) | Creating and installing the GitHub App, and the events it subscribes to |
| [runbooks/GITLAB-SETUP.md](./runbooks/GITLAB-SETUP.md) | Setting up a GitLab project, its token and its webhook |
| [runbooks/agent-runtime-diagnostics.md](./runbooks/agent-runtime-diagnostics.md) | Turning a diagnostic ID from a failed run into the provider detail in the worker log |
| [runbooks/ON-PREM-AWS.md](./runbooks/ON-PREM-AWS.md) | Draft proposal for a self-hosted AWS deployment. Not implemented, and it predates the move to Neon Postgres |
| [releases/artur/README.md](./releases/artur/README.md) | The Artur release contract: the two pull request flow, from preparation to the published tag |
| [releases/artur/upgrade-preflight.md](./releases/artur/upgrade-preflight.md) | The tenant database check that has to pass before a release pull request merges |
| [releases/artur/rehearsals/README.md](./releases/artur/rehearsals/README.md) | How to rehearse a pinned source commit and record the result the sync requires |

## Research

Measurements and primary-source notes. They are dated and never restamped: a
research file records what was true on its date.

| Document | What it is for |
|---|---|
| [research/2026-09-09-architecture-audit.md](./research/2026-09-09-architecture-audit.md) | Current state of the codebase, measured: cycles, tiers, gates, documentation inventory, target shape |
| [research/2026-09-09-agent-navigable-codebase.md](./research/2026-09-09-agent-navigable-codebase.md) | What Anthropic publishes about how agents load a codebase, with the hard rules separated from the recommendations |
| [research/2026-09-09-monorepo-boundary-enforcement.md](./research/2026-09-09-monorepo-boundary-enforcement.md) | How boundaries can be enforced here, and what Nitro and the Workflow DevKit constrain |
| [research/2026-09-09-roadmap-backlog-fit.md](./research/2026-09-09-roadmap-backlog-fit.md) | How the restructure plan fits the product roadmap and the open backlog |
| [research/2026-08-12-arthur-engine-scope-and-evals.md](./research/2026-08-12-arthur-engine-scope-and-evals.md) | Scope of the Arthur Engine integration and its evaluation surface |
| [research/2026-08-12-workflow-guardrails.md](./research/2026-08-12-workflow-guardrails.md) | Design study for enforceable guardrails on high-risk actions |
| [research/2026-07-21-agent-memory-systems.md](./research/2026-07-21-agent-memory-systems.md) | Prior art for the agent memory feature |

## Plans in flight

| Document | What it is for |
|---|---|
| [plans/2026-09-09-architecture-restructure.md](./plans/2026-09-09-architecture-restructure.md) | The restructure being executed now: stages, decisions, assumptions, freezes |
| [plans/2026-09-09-architecture-restructure-tickets.md](./plans/2026-09-09-architecture-restructure-tickets.md) | The Jira drafts for those stages |

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

## Artifacts, not documents

These carry their own required first lines and their own consumers, so they
have no status header and the docs gate skips them.

| Artifact | Consumer |
|---|---|
| `docs/releases/artur/YYYY.MM.PATCH.md` | The release pipeline copies the reviewed note into the tenant repository |
| `docs/example-skill/SKILL.md` | The example agent skill referenced from SETUP.md |
| `docs/example-workflows/loop-branch-workflow.json` | An importable example definition |
