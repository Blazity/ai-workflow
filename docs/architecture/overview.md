Status: current
Last-verified: 2026-09-11

# The services tier

`apps/worker/src/services/` is the worker's domain layer. Each subdirectory is
one cluster: a named domain with an explicit home, its own colocated tests, and
an `index.ts` that states the cluster's public interface. Stage 6b of the
[architecture restructure](../plans/2026-09-09-architecture-restructure.md)
created it by retiring `apps/worker/src/lib/` and by splitting the mixed
top-level directories by file role.

The tiers, the allowed edges, and the reason services are a fenced directory
rather than a workspace package are
[ADR-001](../adr/ADR-001-layering-and-packages.md). This document is the map of
what lives inside the tier.

## What every cluster may import

A services file may import `engine/`, `adapters/`, `db/`, `infra/` and the
workspace packages. It may not import `app/` (`routes/`, `mcp/`, middleware,
plugins, `auth.ts`) or `config/`. The boundary gate counts every violation and
fails on growth, so the table below states only what each cluster owns.

Five directories keep their old names because stage 7 still owns the store
files inside them: `approvals/`, `clarifications/`, `manual-dispatch/`,
`schedule-trigger/` and `webhook-trigger/` each retain a `store.ts`,
`*-store.ts` or `*-schema.ts` that becomes a repository in stage 7. Everything
else in those directories moved into the matching services cluster.

## The clusters

| Cluster | What it owns |
|---|---|
| `approvals/` | Turning an approved plan into a new run, on top of the approval store that stage 7 still owns |
| `auth/` | Dashboard identity: roles, invites, SSO handoff, trusted origins, the seeded auth environment, and the request actor |
| `clarifications/` | The clarification lifecycle outside its store: answering and resuming, expiry, checkpoints, and comment formatting |
| `dispatch/` | Trigger ingestion and run dispatch: eligibility, rate limits, delivery bookkeeping, the post-PR gate hand-off, and autofix caps |
| `dispatch-queue/` | The at-capacity queue that holds a subject until dispatch capacity frees up |
| `email/` | Outbound email: the provider client, invite delivery, message templates, and the verified Resend delivery webhook that updates the delivery ledger |
| `harness/` | Harness profiles: what an organization may author, publish and pin, the skill sources it pins from, and the capability catalog behind them |
| `json-schema/` | Authoring-time inspection of a JSON Schema the dashboard is editing |
| `manual-dispatch/` | Operator-initiated dispatch of one trigger node, its preflight, its HTTP shape, and recovery |
| `mcp/` | The MCP surface below its transport: the contract vocabulary, the actor a verified token resolves to, the audit, idempotency and rate-limit ledgers, and the database-backed work a tool performs |
| `memory/` | Agent memory: what the dashboard may read of what the agent remembered, and what it may erase |
| `overview/` | The read models the dashboard renders: runs, workflows, block statuses, evals, awaiting runs, and run detail |
| `pre-pr-checks/` | The stored pre-PR check configuration: what the dashboard reads of it, and how it is edited and restored |
| `prompts/` | Prompt library service operations over the stored prompt records |
| `publication/` | Text that leaves the worker: scrubbing, branch and gate-check naming, push suppression, dashboard links, and the human-decisions memory section |
| `repository-discovery/` | The repository catalog and the expansion protocol the agent answers with |
| `run-lifecycle/` | A run from reservation to cancellation: the subject key, active-run ownership, start, stall watchdog, step drain, and reconcile |
| `schedule-trigger/` | Schedule parsing, occurrence planning, revocation, and the scheduled dispatch pass |
| `settings/` | Deployment settings the rest of the tier reads, as named accessors, so `config/env` is read in one place |
| `slack/` | The Slack surface: signature verification, slash-command parsing and handling, formatting, and message search |
| `system/` | Deployment identity plus system-health probes, observations, the stored scan, and the body `/health` answers with |
| `telemetry/` | Run telemetry: snapshots, awaiting resolution, and orphan sweeps |
| `tickets/` | Issue-tracker state: transitions, labels, move targets, and AI-review routing |
| `triggers/` | Trigger ingress: the provider webhooks (Jira, GitHub, GitLab, Slack, email delivery), the public custom webhook endpoints, and the scheduled poll |
| `vcs/` | Provider integrations: the adapter factory, VCS clients and runtime, bot identity, and webhook normalization |
| `webhook-trigger/` | The mechanics `triggers/` calls for a custom webhook delivery: authentication, rate limits, payload mapping, rejection counters, and dispatch, on top of the endpoint store stage 7 still owns |
| `workflow-definitions/` | Workflow definitions: what the editor may read, author, deploy and roll back, and how a trigger node is wired to a schedule, a webhook or a manual dispatch |

## The cluster interface

Every cluster has an `index.ts` that re-exports exactly the symbols consumed
from outside the cluster. It is the cluster's declared interface: read it to
learn what a cluster offers without reading its files, and add to it when a new
symbol becomes public.

One cluster may not reach past another cluster's `index.ts`.
`scripts/gates/boundaries.mjs` enforces that rule and prints the current count.
The imports that predate the rule are recorded in
`scripts/gates/cluster-deep-imports.json`, an explicit reviewed list: a new deep
import fails the gate, and an entry that no longer exists must be removed from
the list. Two things are outside the rule by design. A lazy `import()` keeps its
deep path, because a cluster interface would load the whole cluster where the
code deliberately loads one module. Test files are outside it too, because the
boundary gate never analyzes them. `knip.json` lists service interfaces and
test tooling entries so the unused-code gate never counts an interface or a
test entry as a dead file, whatever the current set of importers is.

Consumers in other tiers (`routes/`, `mcp/`, `engine/`, `adapters/`, `db/`)
import cluster files directly. Routing them through the interface would pull
every module a cluster owns into their module graph, which changes what is
evaluated at import time and, for the workflow bundle, what the Workflow DevKit
has to keep free of Node built-ins. The interface is the contract; it is not a
re-entry point for the rest of the worker.

That is not a style preference, it is measurable. Every cluster reaches another
cluster through an interface, so the interfaces together form one graph: an
app-tier file that imports any of them loads all of them, and through them the
engine. A route that imports `services/auth/index.js` for the request actor
pulls about 400 modules and 51 `"use step"` files where the module it actually
needs pulls under 30 and none, and `/health` has to answer while the deployment
is degraded. So a route, an MCP file, middleware or a plugin names the cluster
module it uses; only clusters name each other's interfaces. A symbol more
than one cluster raises belongs below them for the same reason:
`TriggerHttpError` lives in `infra/trigger-http-error.ts`, so the email and
Slack services throw the refusal without importing the trigger cluster's
interface, and `services/triggers/trigger-http-error.ts` re-exports it for the
webhook routes, which may import `services` but not `infra`.

## Where to read next

- [ADR-001](../adr/ADR-001-layering-and-packages.md), the tiers and the allowed edges
- [apps/worker/AGENTS.md](../../apps/worker/AGENTS.md), the worker's directory map and its traps
- [docs/architecture/blocks.md](./blocks.md), how the engine's blocks are shaped
