Status: draft
Last-verified: 2026-09-21

# Integrations: every third party as one package that unlocks blocks, screens and tools

Planned on 2026-09-18 from a read-only recon of `main` at
`57baffcacdce54a29608fd1f02e284f8bf9649f0`, the syncs with Jakub and Artur on
2026-09-14 and 2026-09-17, the roadmap of 2026-08-27 (P3 "Third-party
integrations", P3 "Provider-neutral safety and observability", and the delivery
rule "keep the core platform provider-neutral; third-party engines remain
optional"), and the open AIW backlog (AIW-395, AIW-394, AIW-396, AIW-290,
AIW-294, AIW-14).

## Problem

1. Connecting anything means editing environment variables on Vercel and
   redeploying. Settings deliberately hold no credentials
   (`packages/contracts/settings-registry.ts:4-8`), so no screen and no MCP tool
   can say what is connected, whether it works, or what connecting it would
   unlock.
2. Third-party screens sit among core screens whether the provider exists or
   not. "Arthur evals" is always the sixth item in a flat sidebar of thirteen
   and renders an empty state without Arthur
   (`apps/dashboard/components/cockpit/chrome.tsx:6-28`,
   `apps/worker/src/routes/api/v1/evals.get.ts:20-29`).
3. The editor already knows which blocks this deployment can run, through a
   hand-written list of provider conditions in core
   (`apps/worker/src/engine/definition/block-contract-resolver.ts:78-194`,
   `block-contract-environment.ts:28-58`). Every new provider is one more
   special case in the middle of the engine.
4. Provider names are spread through core. Outside their own adapter
   directories, non-test worker files reference Jira 14 times, Arthur 14,
   GitHub 9, Slack 7 and GitLab 7 (recon; for example
   `apps/worker/src/services/dispatch/reconcile.ts:271`,
   `apps/worker/src/engine/agent-workflow.ts:522`,
   `apps/worker/src/engine/blocks/prepare-workspace/execute.ts:296`). Swapping
   Jira for Linear (AIW-14) or adding a memory provider means editing the
   engine.
5. One block mixes two providers: `investigate` reads Jira through the port and
   searches Slack directly (`apps/worker/src/engine/blocks/investigate/execute.ts:345-433`).
6. A safety check fails open: `arthur_injection_check` returns `skipped` when
   Arthur is not configured
   (`apps/worker/src/engine/blocks/arthur-injection-check/execute.ts:45-148`).
7. Nobody outside the core team can add an integration. There is no designated
   place in the code, no contract, and no guide.
8. Memory has no seam. Facts and lessons are read and written straight from the
   database (`apps/worker/src/memory/repo-memory.ts:8-55`,
   `apps/worker/src/db/repositories/memory.ts:9-50`), so a provider such as
   Mem0 cannot be put in its place.
9. The health page, the MCP catalog and the settings registry each hard-code
   their own provider list (`apps/worker/src/services/system/collect.ts:163-285`,
   `apps/worker/src/mcp/tool-catalog.ts:30-40`, `settings-registry.ts:366-392`).

## Solution

From the user's side:

- **Integrations get their own page in the sidebar**, next to the product's
  work rather than inside Settings, which stays for product settings (agent
  limits, timeouts), System health and Users. One card per integration the build
  ships: logo, one line of what it is, status (Connected, Not connected,
  Failing, Disabled) and where the connection comes from (the deployment's
  environment or values stored from the dashboard), when it was last verified,
  what it unlocks (capabilities, blocks, screens), a connect form
  generated from the integration's own declaration, a test button, an enable
  switch, and a link to its documentation. When several connected integrations
  can serve a capability that has one active provider (issue tracker,
  messaging, memory), the admin picks which one is active.
- **Connecting makes the integration appear everywhere at once**: its blocks in
  the editor palette grouped under its name, its section in the sidebar below
  an Integrations separator, its checks on the health page, and its blocks in
  what `system.capabilities` reports to agents building workflows over MCP.
  Disconnecting or disabling removes all of that; a workflow that used them
  says which integration it needs and cannot be published.
- **Core blocks stop naming providers.** "Comment on ticket", "Open pull
  request" and "Send message" work through whichever connected integration
  provides the capability, the way pull request blocks already work for GitHub
  and GitLab. Provider-specific work (Arthur's injection check, Slack research,
  Jira research) is a block of that integration.
- **MCP covers what workflows can do, nothing more** (Jakub, 2026-09-18).
  Connecting an integration, entering tokens, disabling it and choosing a
  provider happen in the dashboard only, so no credential ever passes through a
  chat with a model. An agent building or running workflows over MCP learns
  which integrations are connected and which blocks it may use.
- **A developer adds an integration by writing one package.** They copy the
  template, follow one guide, and the build finds it. Types and CI gates reject
  an integration that reaches into core internals, and core code that names a
  specific integration.
- Arthur, Slack, GitHub, GitLab and Jira all ship as integrations. Memory
  becomes a capability with a built-in provider, so a provider such as Mem0 can
  be added later and selected.

## Users and situations

- **An admin setting up a fresh deployment.** Nothing is connected, and they do
  not know what the product can talk to. They arrive at the Integrations screen
  expecting to learn the options, paste credentials, and be told immediately
  whether they are right. They will paste a wrong token at least once.
- **An admin of a running deployment (our production, the Arthur tenant).**
  Everything is configured through environment variables today. They must see
  that the environment is the source and keep working with zero action; a
  surprise override would be a production incident.
- **A workflow author in the editor.** They want a palette of blocks that can
  actually run here, and, when they open an older workflow, a clear statement of
  which integration is missing rather than a run that fails later.
- **A member (read-only role).** They see what is connected and healthy, never
  a secret and never a control that does nothing when clicked.
- **An agent building or running workflows through MCP.** Learns which
  integrations are connected and which blocks it can use, gets a draft issue
  naming a missing integration, and sees `integration_unavailable` on a run.
  It cannot connect, configure, disable or read the credentials of any
  integration.
- **A developer writing a new integration**, internal or a customer's engineer
  in a fork. They know their provider's API and nothing about our engine. They
  need one guide, one template, one command, and a failing test that explains
  itself.
- **A person waiting for a run whose integration is disconnected.** They get a
  failed run naming the integration and the usual ticket comment, not silence
  and not a skipped safety check.
- **An operator on a phone** checking whether an integration went red.

## User stories

1. As an admin I want to see every integration this build ships with its
   status, so I know what the deployment can do.
2. As an admin I want to connect an integration by filling the fields on its
   card and learn at once whether the connection works.
3. As an admin I want a wrong credential to give me a failed status with the
   provider's own reason.
4. As an admin I want secrets to be write-only, so nothing I save can be read
   back through the screen, the API, MCP or the logs.
5. As an admin of an environment-configured deployment I want the card to say
   so and keep working without me touching anything.
6. As an admin I want to disable an integration without losing its
   configuration, whichever source it uses.
7. As an admin I want to choose which connected integration serves a capability
   that has one active provider.
8. As a workflow author I want the palette to show only blocks that can run
   here, with an integration's blocks grouped under its name.
9. As a workflow author I want a workflow using a disconnected integration to
   name it, with publishing refused until it is connected.
10. As a person waiting for a run I want a run that needs a disconnected
    integration to fail at once with the integration named, and never to skip
    the step silently.
11. As a user I want an integration's own screens to appear only when it is
    connected, below a separator, never mixed with core screens.
12. As an operator I want System health and Users under Settings so the sidebar
    holds daily work.
13. As an operator I want each connected integration's checks on the health
    page without core maintaining the list.
14. As an admin I want integration management to live only in the dashboard,
    so no token I own ever passes through a chat with an agent.
15. As an agent I want `system.capabilities` to report the connected
    integrations, the capabilities they serve and the blocks they unlock.
16. As a workflow author I want Slack research and Jira research as separate
    blocks belonging to their integrations.
17. As an admin I want to switch memory to another provider and have the next
    run use it.
18. As a developer I want one guide, one template and one command to add an
    integration without reading the engine.
19. As a developer I want CI to tell me when my integration reaches into core
    internals, or when core reaches into my integration.
20. As a maintainer I want a new integration to require no edit outside its own
    package beyond regenerating the registries.
21. As Arthur's operator I want the injection check to fail closed and return a
    typed verdict (AIW-294).
22. As an agent in a run I want to receive tools from an integration later; the
    contract reserves the slot, this plan does not deliver it.
23. As an admin I want to prepare and test new credentials while the old ones
    are still in use, and switch in one action without a redeploy or an outage.

## What good looks like

- Connecting Arthur takes under a minute from the card, and within that minute
  the card says what was gained and the palette has the block.
- A person never meets a provider name in a core error path. When something is
  missing they read the integration's name and a way to connect it.
- Core holds no import of an integration package outside the generated
  registries and no provider id outside the gate's allowlist, and the gates
  prove it rather than a reviewer noticing.
- Adding the next integration touches only its own package plus regenerated
  files, and the guide is enough to write it.
- Merely passing, and therefore a failure here: cards exist but an
  environment-configured production reads "Not connected"; blocks disappear but
  old workflows die with a stack trace; `system.capabilities` offers an agent a
  block the editor would refuse; the Slack integration exists but core still reads a Slack
  environment variable somewhere.

## Implementation decisions

These are the one-way doors. Everything else belongs to the executors.

### 1. One word

The concept is an **integration** in the interface, the code, MCP, the docs and
the glossary. "Plugin" is the same thing in conversation. Core seams that an
integration can fill are **integration capabilities**; in code they are
`IntegrationCapability*`, distinct from the existing `HarnessCapability*` of
the model catalog, and `CONTEXT.md` records the difference.

### 2. Layout: one package per integration

A top-level workspace folder `integrations/`:

- `integrations/sdk` (`@integrations/sdk`): the contract. Manifest types,
  `defineIntegration`, capability port interfaces, the context interface,
  conformance helpers. It may import `@shared/contracts` and `zod`, nothing
  else.
- `integrations/<id>` (`@integrations/<id>`): one package per integration, with
  three entry points:
  - `manifest`: pure data (identity, connection fields, declared capabilities,
    block manifests, navigation entries, health check descriptions). Browser-safe and workflow-scope-safe: **no Node modules**,
    because the Workflow DevKit flow bundle fails on them.
  - `worker`: the runtime (connection test, capability adapters, block
    executors, webhook translation, health probes, API handlers).
    Imported only from worker step files and routes, never from `"use workflow"`
    code.
  - `dashboard`: optional React pages for the integration's own sidebar
    section.
- `integrations/_template`: what the scaffold copies.

`pnpm-workspace.yaml` gains `integrations/*`. Packages are TypeScript sources
with `main`, `types` and `exports` pointing at `.ts`, exactly like `packages/*`;
that shape is proven on Vercel for Nitro, Next and the DevKit bundles, and it
must stay free of `transpilePackages` and `externals.inline`. Every package
carries its own `typecheck` script, or it drops out of `pnpm -r`.

### 3. Registration is generated, not listed

The block catalog generator grows into an integration generator. It scans
`integrations/*` (skipping `sdk`, `_template`, and `_fixtures` unless the
fixture flag of decision 20 is set) and writes committed
registries: worker runtime, dashboard pages, block catalog (each entry carrying
its `integration` id and what it requires), and health definitions. `--check` runs inside `build`, as `gen:blocks --check` does today.
Nobody maintains a list by hand.

### 4. No runtime code loading

Integrations are compiled into the build. A deployment decides which are
connected and enabled. A customer adds integrations in their fork. This is not
a preference: the DevKit discovers steps only under `apps/worker/src`
(`apps/worker/nitro.config.ts:27-35`, ADR-001 "The engine as a workspace
package"), so step code installed from npm would not be found, and loading
third-party code at runtime is a security surface we are not opening.

### 5. Integration code carries no `"use step"`

The engine owns one generic step that runs any integration block executor with
a context. Integration executors are plain async functions that take input and
return the block result.

Consequences, and they are deliberate:

- An integration block is exactly one step. Long or multi-phase behaviour
  (agents, loops, waiting for a person, sleeping) stays in core, and an
  integration reaches it through a capability.
- Step identity is module path plus function name, so keeping directives out of
  integration packages means moving or renaming an integration never strands a
  run once this plan is delivered.
- Getting there does strand runs, and not only through integration blocks.
  Today's Arthur block is a step; so is the Arthur task step inside the core
  `prepare_workspace` block
  (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts:294,318-325`),
  which every agent run started with Arthur configured passes through; and S9
  to S12 rewrite core block step files (ticket comment, pull request comment,
  check creation and completion, pull request context, plan approval). The
  rule is therefore general: **any stage that adds, moves, renames or deletes a
  file carrying `"use step"` or `"use workflow"` cancels the runs in flight
  through it on production and demo before merge, and its DoD includes
  `workflow-import-boundary.test.ts` and `step-registration-coverage.test.ts`.**
  R1 does the same for the Arthur tenant.

#### The drain, as somebody who was not here would run it

Every read and write below goes through the authorized product MCP of the
deployment being drained (its own `/mcp`, as an admin account) or that
deployment's dashboard. Not a local server: `aiw-dogfood` is a fake and
proves nothing about production.

1. **Announce** the pause in the team channel, with the window you expect and
   the sentence that anything dispatched during it has to be dispatched again
   afterwards.
2. **Freeze the triggers.** `workflows_list`, then `workflows_set_enabled`
   `false` for each enabled definition. Record the ids: that list is what goes
   back on in step 7, and nothing else does.
3. **Close the other two doors, and say so.** The enabled flag stops the
   webhook, the poll and the schedule. It stops neither the dashboard's Run
   manually nor `workflows.dispatch` over MCP: both dispatch a disabled
   definition without complaint. That half of the freeze is an agreement with
   the people who hold those two doors, so it is verified rather than trusted:
   step 4 is counted again in step 6, immediately before the merge.
4. **Count the runs that have not finished, in the dashboard.** Open
   `/runs?window=all&status=running` and `/runs?window=all&status=awaiting`.
   Both lists must be empty. Use `runs_stats` for nothing here: it answers the
   newest page of a window (20 rows by default, 100 at most) and says
   `runsTruncated`, so it can show a clean page while a run parked three weeks
   ago sits underneath it. A page is not a proof of zero. `blocked` and
   `failed` are finished and are not counted; `awaiting` is a live run parked
   on a person and is.
5. **Empty both lists.** For each run:
   - Post a Jira comment first, with `tickets_comment`, telling the person that
     the run is being stopped for a redeploy and that moving the ticket back
     into the AI column after it restarts the work. `runs_cancel` posts no
     comment of its own, so a run cancelled without this one is a person
     waiting for an answer that will never come.
   - Then `runs_cancel` with a reason naming the redeploy. `cancelled` and
     `already_terminal` are both done.
   - A `CONFLICT` answer means nothing was changed AND may still mean the run
     is over (a cancel that worked has reported this): re-read the run with
     `runs_get` before deciding, and only retry with the same
     `idempotencyKey` while it still reads `running` or `awaiting`.
   - **A run that will not leave RUNNING** is its own case. Read it with
     `runs_diagnose`, then `runs_logs`, and read it again a few minutes later:
     a row whose steps have not moved is a leaked row rather than work in
     flight (it has happened: a reconciler that lost its database handle left
     several). Cancel it the same way, and if the row still will not move,
     stop: an id that stays RUNNING is a blocker to escalate and to record in
     the pull request, not a number to round down to zero.
6. **Count again, immediately before the merge**, the same two lists. A run
   that appeared during the window came through one of the two open doors in
   step 3: cancel it the same way and count again. Merge only from a zero you
   have just seen.
7. **After the deploy**, wait for `/health` to report the merge commit, put the
   recorded definitions back with `workflows_set_enabled` `true`, and run the
   smoke: `/health`, the dashboard login page, and a `workflows_get_graph`
   sweep that returns every definition.
8. **Record** in the pull request: the window, every run id you cancelled, and
   every id that would not move.

**Demo is a second deployment, not a second database.** Today it reports the
production database, which means steps 4 to 6 on production cover it, and that
is a fact to check rather than assume: read `databaseFingerprint` from
`/health` on both deployments and compare. Equal means one count covers both;
different means demo has its own parked runs, and steps 2 to 6 run there too.

### 6. The context is the only thing an integration receives

`IntegrationContext` gives an integration: its resolved connection values
(secrets included, server side only), an HTTP client with timeout, retry and
redaction, a logger, the run and node identity while a block executes, access
to other capabilities through the registry, and a core-owned `llm` for
structured generation, bounded under the 300 s invocation ceiling
(`apps/worker/src/infra/llm.ts`), because research blocks synthesise with a
model today (`apps/worker/src/engine/blocks/investigate/execute.ts:298,477,532`).
No database handle, no process environment, no worker imports. A capability
that needs core storage is implemented in core (see decision 10).

S0 designs the context from an inventory of what the five current providers
actually use from the worker, not from first principles. After S0 the SDK
changes only additively: a stage that needs more adds it within its own scope,
the gate reviews the addition, and ADR-010 records it in a change log section.

### 7. Capabilities

| Capability | Port | Cardinality | Provided today by |
|---|---|---|---|
| `issue_tracker` | `IssueTrackerAdapter`, moved from `apps/worker/src/adapters/issue-tracker/types.ts:115-211` | one active per deployment | Jira |
| `vcs` | `VCSAdapter`, moved from `apps/worker/src/adapters/vcs/types.ts:264-297` | many at once, chosen per repository by its provider | GitHub, GitLab |
| `messaging` | `MessagingAdapter`, moved from `apps/worker/src/adapters/messaging/types.ts:62-75` | one active | Slack |
| `memory` | new `MemoryStore` port | one active | built-in (core) |
| `agent_tracing` | new: per-run tracer configuration contributed to agent sandboxes | many | Arthur |
| `agent_tools` | reserved: MCP servers handed to sandbox agents | many | nobody; slot only |

A core block declares the capabilities it requires; an integration block
requires its integration. Agent and LLM providers (Claude, Codex) are not
integrations in this plan: the harness profile and model catalog (ADR-006) own
them, and turning them into a capability is a later plan.

`agent_tracing` is designed in S8 from what Arthur's tracer does today
(`apps/worker/src/sandbox/agents/claude.ts:156-158,510-558`, `codex.ts:95-101`):
a package to install, a hook file built by the worker's `build:arthur-tracer`
script, hook events registered per harness, and a configuration file carrying
the API key inside the sandbox. The port therefore describes files, environment
and per-harness hooks declaratively, and core applies them per harness; the
integration never learns how a harness is wired. This is the one declared
exception to "secrets never leave the server": a secret an integration hands to
a sandbox through `agent_tracing` is declared in its manifest and redacted from
run logs and traces. Every other route for a secret into a sandbox waits for
AIW-392.

### 8. Webhooks

One generic worker route `/webhooks/[id]` dispatches to the integration's
webhook handler, so the URLs registered with providers today
(`/webhooks/jira`, `/webhooks/github`, `/webhooks/gitlab`, `/webhooks/slack`)
keep working unchanged. A handler verifies the request and returns normalized
core events (ticket moved to a status, pull request created, updated, reviewed,
checks failed, merged, a slash command); core owns dispatch from there. The
custom webhook trigger stays core. An event for a disabled integration is
accepted, so the provider neither retries nor disables the webhook, dispatched
nowhere, and recorded as ignored with the reason; the poller does the same.

### 9. Connection state

One table `integration_connections` (integration id, enabled, source, non-secret
connection config JSONB, secret ciphertexts, last test time, status and
message, updated by) plus an append-only `integration_connection_versions` for
audit, and the active provider selection per single-provider capability. The
rules:

- **Two sources, one active, chosen explicitly.** An integration's connection
  comes either from the environment variables it declares or from stored
  values, and the row records which. With no row, the environment is the
  source when the declared variables are complete, so production and the
  Arthur tenant keep running untouched: no data migration. An admin may fill
  and test stored values while the environment is still the source, then
  switch the source in one action; rotating a token never requires deleting
  variables, redeploying, or an outage.
- **A partial environment is Failing, not Configured.** When some but not all
  required variables are set, the status names the missing ones (today GitHub
  counts as configured only with all three of app id, private key and
  installation id, `apps/worker/src/infra/vcs-config.ts:32-34`).
- **Only connection values come from the environment.** Operator-edited
  behaviour (Jira columns, transitions, a Slack channel choice) is never
  sourced from the environment and never read-only. The Jira columns stay
  stored settings rows, as they are today
  (`packages/contracts/settings-registry.ts:365-393`, their environment
  variables already retired), and move from the "Issue tracker" settings group
  to settings of the `issue_tracker` capability that any tracker reads, Linear
  included. Nothing about their stored values changes.
- **Disable is a stored flag that works for either source**, including an
  environment-configured integration. It is read live at every use, not frozen,
  because it is the kill switch an admin reaches for when a bot misbehaves.
- **A run pins a connection version at start** and resolves config and secret
  together from it. A later version that changes only secrets is followed, so
  rotation works mid-run. A later version that changes connection config (a
  different Jira site, a different Arthur engine) fails the run at its next use
  with `integration_unavailable`, reason `reconfigured`, instead of mixing the
  old site with the new token.
- Secrets are encrypted with the existing AES-256-GCM helper
  (`apps/worker/src/infra/webhook-crypto.ts:70-100`) under a new
  `INTEGRATION_SECRETS_KEY`, whose envelope carries a key id. Without the key,
  stored secret fields are disabled with an explanation and
  environment-configured integrations are unaffected. A ciphertext under
  another key id reads as Failing, "stored under another key, enter it again",
  never as a crash. Every deployment that shares a database must share the key.
  Secrets never leave the server (the one declared exception is decision 7's
  `agent_tracing`): not in an API response, not in an MCP result, not in a log
  line.
- **Writes are refused where the deployment is not the database's own.**
  Preview deployments read the production database
  (see `/health`: `databaseEnv` against `env`), so a toggle on a preview would
  disable production's integration. Integration writes succeed only when the
  deployment's environment matches the database's environment marker; reads
  work everywhere.
- Writes are single statements. Production runs neon-http, which has no
  interactive transactions.
- **Saving tests before it activates.** New values become the active version
  only when their connection test passes; when it fails, the previous working
  connection stays active and the card says why the new values failed. Saving
  failing values anyway (a provider outage) is a separate, explicit action.
  Status is one of Connected, Failing with the reason, Not connected, Disabled,
  and each shows its source (environment or stored).
- A secret field left untouched on edit keeps the stored secret; clearing a
  secret is its own action. Disconnecting removes the stored values and every
  stored secret from every past version; the audit keeps who and when.
- **Impact before change.** Disable, disconnect, reconfigure and provider
  selection first report what depends on the integration (published
  workflows, runs in flight, dispatch that will stop) on the screen before the
  admin confirms.
- The active provider of a single-provider capability is pinned at run start
  with the connection version, so a run never writes memory to one engine and
  reads it from another.
- A row whose integration no longer exists in the build is ignored, and
  workflows that used its blocks report an unknown integration.
- Owner and admin connect, test, toggle, switch source and select, in the
  dashboard only; members read status only. MCP has no integration write tool
  (decision 15).

### 10. Built-ins live in core

An implementation that needs core storage, such as built-in memory, is a core
module registered as a built-in provider of a capability. It appears on the
Integrations screen with no connection fields and can be deselected in favour
of an external provider. It is not an `integrations/*` package, because an
integration gets no database.

### 11. Availability comes from the catalog

`block-contract-resolver.ts` keeps its shape (pure, with the deployment passed
in) but its context becomes the integration states and capability providers
instead of per-provider booleans, and the rule "this block needs integration X
or capability Y" comes from the generated catalog rather than from a condition
written in core. Rules that depend on a block's own parameters stay with the
block that owns them.

### 12. Unavailable at run time is loud

A deployed workflow that needs a disconnected or disabled integration: a new
run fails at start with the typed cause `integration_unavailable` naming the
integration and a reason (`disconnected`, `disabled`, `reconfigured`), visible
in the run view and in the standard ticket failure comment when a ticket
exists; a run already in flight fails at its next use of the integration with
the same cause. Nothing is skipped. In particular the injection check fails
closed.

The one exception is memory. When the active memory provider is unavailable a
run continues without memory, and the run view and the health page say that
memory was unavailable and why. Memory enriches a run and does not gate it;
failing every run because a memory engine is down would make an optional
provider the product's single point of failure. The degradation is visible,
never silent.

### 13. The editor

The palette shows core blocks whose capabilities are provided, and the blocks
of connected, enabled integrations grouped under the integration's name. A node
on the canvas whose integration is unavailable shows which one and a link to
connect it, and publishing is refused naming it.

### 14. The sidebar

Core groups first, then an Integrations separator. Below it sit the
Integrations page (`/integrations`, every card, where anything is connected;
Filip, 2026-09-18: a page of its own, not part of Settings) and one entry per
connected, enabled integration. An integration's entry opens its own area
(`/integrations/<id>`) whose horizontal tabs are its contributed pages plus its
connection tab (Arthur: Evals, Connection), as Jakub asked for Arthur on
2026-09-14. Sidebar groups collapse, and
the sidebar fits a 1080p screen without scrolling. System health and Users move
under Settings. This is AIW-396 and AIW-290 delivered by the same mechanism.

### 15. MCP covers what workflows can do, nothing more

Jakub, 2026-09-18: only the actions a workflow can perform are exposed through
MCP. For integrations that means:

- No integration management tools. Connecting, entering or reading
  credentials, testing, enabling, disabling, switching source and choosing a
  provider are dashboard actions only. A token therefore never passes through a
  chat with a model, where it would land in the model's context and the model
  provider's logs.
- `system.capabilities` reports, read-only, which integrations are connected
  and enabled and which blocks they make available, computed by S4's resolver
  so MCP and the editor never disagree. An agent needs this to build
  workflows; it carries no configuration and no secret.
- Workflow authoring over MCP gets the same issue as the editor when a draft
  uses an unavailable integration's block, and run tools report
  `integration_unavailable` like the run view.
- Integrations contribute no MCP tools in this plan, and screens have no MCP
  twin (no `arthur.evals_summary`). Whether read-only integration data may be
  exposed later is an open question to Jakub.
- The MCP tools that exist today (settings, repository catalog) stay as they
  are; this decision covers integrations only (Filip, 2026-09-18).

A guard test asserts the MCP catalog holds no integration management tool, so
one cannot be added by accident.

### 16. Gates

The boundaries gate gains rules: nothing outside the generated registries
imports `@integrations/<id>`; an integration imports only `@integrations/sdk`,
`@shared/contracts` and its own dependencies; integrations never import each
other; the worker never imports a `dashboard` entry and the dashboard never
imports a `worker` entry. A conformance test runs over every integration
package: the manifest parses, every declared block has a schema and an
executor, a connection test exists, health checks are declared, the environment
variable names are declared, a README and a logo exist, and every schema the
package declares parses the same under zod 3 and under the `zod4` alias the
production bundle resolves (`pnpm-workspace.yaml:15-20`). The SDK re-exports
`z` so an integration does not pick its own.

"Core names no provider" is a gate, not a grep in a DoD. A core-reference rule
takes the integration ids from the generated registry and fails on any
provider id used as an identifier or a string literal in core source, with an
explicit allowlist: applied migration files, stored identifiers in schema
defaults and history, tenant release tooling (the Arthur tenant repository is
not the Arthur provider), the changelog, and tests. The allowlist lives in the
gate's config and every entry carries a reason.

### 18. Integration screens look like the product

An integration's `dashboard` entry may import a host UI package that the
boundaries gate allows (the cockpit primitives it needs, so a page does not
reach for the dashboard-only `@/components/ui` alias), and the dashboard's
Tailwind entry gains an `@source` for `integrations/*/dashboard`, since
Tailwind v4 does not scan workspace packages on its own. What goes into the
host UI package, and whether it is extracted or re-exported, is S7's call.

### 19. The repository provider is validated against the registry

The database constrains repository and run providers to `github` and `gitlab`
with CHECK constraints (`apps/worker/src/db/schema/repositories.ts:75`,
`apps/worker/src/db/schema/runs.ts:430`). A third VCS integration written from
the guide would pass conformance and then fail on import. S10 replaces those
constraints with validation against the registry of `vcs` providers. This is a
schema migration with no data change. Signed off by Filip on 2026-09-18 ("so
that other providers are possible").

### 20. Fixtures stay out of production

The test integration lives in `integrations/_fixtures/*`. The generator
includes it only when a build flag is set, which CI and the demo deployment
set and production and the Arthur tenant never do. Conformance covers it in CI
either way.

### 17. No backward compatibility for development data

Filip, 2026-09-18: nobody depends on the current blocks or workflows. Removed
blocks (`investigate`, `send_slack_message`, the Arthur check in its current
location) are deleted rather than aliased, and the workflow definitions that
use them are deleted and re-authored. Runs in flight are handled by the drain
rule of decision 5. The Arthur tenant's definitions are re-authored in a
coordinated release (R1) after the provider stages, and until R1 the tenant
stays on its current release.

**Amended for Slack, Filip, 2026-09-20.** Two enabled production definitions
use `send_slack_message`, and deploy day must not break them, so:

- `send_slack_message` **migrates** into the new core `send_message` block
  rather than being deleted: same parameters, same ports, same status
  variants, same destination. Nobody re-authors anything. The new build
  accepts the old type (a stored row is canonicalised when it is read, and a
  run replaying a plan recorded before the rename still executes it), and the
  stored graphs are rewritten afterwards by a separate, explicitly invoked
  one-off, never from the build path: the worker's `build` runs `db:migrate`
  and a preview deployment shares production's database, so a rewrite carried
  by a migration would rewrite production's definitions from a preview deploy
  of an unmerged branch. The alias is removed in R1, after the rewrite is
  verified. See ADR-010, "Slack, and messaging as a capability, decided in S9".
- `investigate` **stays in core** with its block type and its behaviour intact
  until S12. Only its chat half stops importing a provider and goes through
  the messaging capability. Its parameters still spell a provider name as
  data (`providers: ["jira", "slack"]`, `slackChannels`, `slackLookbackDays`),
  and those rows are listed in the core-reference gate's allowlist with S12 as
  their removal point rather than being smuggled through.

## Open to the executors

- Screen layout, card design, copy, empty, loading, error and permission
  states, within `DESIGN.md`. (Where Integrations lives is decided: its own
  page, decision 14.)
- The internal structure of each integration package and of the generator.
- The names of core capability blocks, and whether research is one core block
  over capabilities or one block per integration. Slack research must belong to
  the Slack integration; Jira research may be either.
- How the generic integration step reports progress and failure, as long as the
  run view and the trace keep showing the block like any other.
- Which health checks each integration declares, and how a connection test
  differs from a health check when a provider offers no cheap probe.
- The form of the scaffold (a command or a documented copy).
- Whether the Integrations screen groups cards (connected first, by category,
  or flat).

## Seams and test decisions

Tests are derived from [the scenario catalogue](../qa/integrations-scenarios.md),
never from the code under test. Its first section states the rules: scenarios
first and from someone else, the highest seam that observes the behaviour,
expected values from an independent source, every test seen failing once, edge
cases before the happy path.

| Seam | What we observe through it | Prior art |
|---|---|---|
| Block contract resolver | Given a declared deployment and a block, the editor and validation agree on available or unavailable, with the integration named | `apps/worker/src/engine/definition/block-contract-resolver.ts:78-194`, deployment passed in by `block-contract-environment.ts:60-87` |
| Connection resolution | Given environment variables and a stored row, the status, the source and the active provider are as specified, and no secret appears in the output | settings resolution freeze `packages/contracts/settings-resolution.ts:119-140`; webhook secret encryption `apps/worker/src/infra/webhook-crypto.ts:82-100` |
| Generic integration block step | A fixture integration's block runs in a real workflow, its output binds downstream, and a disabled integration fails the block with `integration_unavailable` | `apps/worker/src/workflow-graph-suites/`, the engine canary |
| Webhook translation | A recorded provider payload through `/webhooks/<id>` produces the same normalized event and the same dispatch as today | `apps/worker/src/routes/webhooks/*.post.ts` and their tests |
| Capability ports | Core behaviour (open a pull request, comment on a ticket, send a message, read and write memory) against a fake adapter, and each real adapter against recorded provider responses | `apps/worker/src/adapters/*/` and their tests |
| Generator and boundaries | Adding a fixture integration folder appears in every registry after generation, `--check` fails while stale, and a planted core import of an integration fails the gate | `docs/architecture/blocks.md:24-46`, `scripts/gates/boundaries.mjs:139-155` |
| MCP contract | `system.capabilities` lists exactly what the editor palette offers for the same state, the snapshot holds no integration management tool, no response carries integration configuration | `pnpm mcp:contract:check`, `apps/worker/src/mcp/tools/authoring-support.ts` |
| Conformance | Every `integrations/*` package satisfies the contract | new, built in S1 |

TDD applies to the resolver, connection resolution, the generic step, webhook
translation, capability selection and the MCP guard. It does not apply to screens,
generated files or mechanical moves.

## Out of scope

- Loading integration code at runtime, or installing an integration from npm.
- Handing sandbox agents MCP servers from an integration. The `agent_tools`
  slot is declared; delivery waits for the sandbox environment forwarding
  redesign (AIW-392) so secrets reach a sandbox once, by one mechanism.
- Agent and LLM providers as integrations.
- Per-workflow issue tracker columns. The capability design must not prevent
  it; this plan does not deliver it.
- Linear (AIW-14). Unblocked by this plan, built after it.
- Key rotation for `INTEGRATION_SECRETS_KEY` beyond storing a key version.
- Multi-tenant configuration. One deployment is one tenant, as today.

## Assumptions

- **A1 (revised).** One step per integration block is enough for the blocks we
  know, given the context carries `llm` (decision 6). Anything needing more
  becomes a capability used by a core block.
- **A2 (revised).** The source is explicit per integration (decision 9); mixed
  sources within one connection are refused because a half-overridden
  connection is impossible to reason about.
- **A3.** `issue_tracker`, `messaging` and `memory` have exactly one active
  provider per deployment. Two trackers at once is not a need today.
- **A4 (revised).** The dashboard imports a `dashboard` entry of a workspace
  package as TypeScript source like `packages/*`; styling holds only with the
  host UI package and the Tailwind `@source` of decision 18, and S7 proves it
  on a fixture page.
- **A5 (superseded 2026-09-18).** Integrations contribute no MCP tools in this
  plan (decision 15), so the question of how they are listed is moot.
- **A6 (revised).** Cancelling runs in flight before any step-changing merge is
  acceptable on production and demo, because usage is our own. The tenant is
  drained separately in R1.
- **A7.** Core health keeps database, authentication, email and MCP; every
  provider check comes from its integration.
- **A8 (revised).** One `INTEGRATION_SECRETS_KEY` per database, shared by every
  deployment that reads it; writes happen only on the database's own
  deployment (decision 9).
- **A9 (revised).** The Arthur tenant stays on its current release until R1,
  which drains its parked runs, warns its operator, and re-authors its
  definitions.
- **A10 (revised).** Memory engines come after the existing providers (Jakub,
  2026-09-18), so S13 and S15 form a later phase after R1. S14 proves the guide
  on the fixture integration; S15 needs an engine's API key when its turn
  comes.

## Pre-mortem triage

The skeptic pre-mortem of 2026-09-18 returned REVISE with ten findings. Each
one's fate:

| # | Finding | Fate |
|---|---|---|
| 1 | Jira columns are stored settings; making them integration config sourced from the environment would lose them | Plan corrected: decision 9, operator-edited behaviour never comes from the environment; the columns become `issue_tracker` capability settings; S12 scope widened |
| 2 | Environment-first made rotation an outage, a partial environment looked configured, and S8's DoD could not run | Plan corrected: explicit source per integration, stored values prepared while the environment is live, partial environment is Failing, Disable works for both sources |
| 3 | Run-start freeze contradicted fail-in-flight on disable | Plan corrected: enabled read live; runs pin a connection version and follow secret-only changes; reconfiguration fails with reason `reconfigured` |
| 4 | Drain rule covered only the Arthur block; `prepare_workspace` and S9 to S12 also change steps; tenant never drained | Plan corrected: decision 5 made general, guard tests in every step-changing DoD, R1 drains the tenant |
| 5 | Previews share the production database, so a preview toggle disables production | Plan corrected: writes only on the database's own deployment, one key per database, key-id mismatch reads as Failing |
| 6 | The context had no LLM for research blocks; `agent_tracing` needs harness internals and a secret in the sandbox | Plan corrected: `ctx.llm`, S0 designs from an inventory, SDK additive after S0, `agent_tracing` designed in S8 with the declared secret exception |
| 7 | Styled integration pages and zod 3 against 4 were not covered by the existing proof | Plan corrected: decision 18 (host UI package, Tailwind `@source`), conformance under both zod versions, SDK re-exports `z` |
| 8 | "No reference" greps cannot pass, and the database constrains providers to two | Plan corrected: core-reference gate with a reasoned allowlist; decision 19 replaces the CHECK constraints, signed off by the product owner |
| 9 | S3 depended on S4; S9 and S13 shared files | Plan corrected: S3 after S4 and reading S4's resolver; S9 and S13 in sequence |
| 10 | The fixture integration would ship to production and the tenant | Plan corrected: decision 20, fixtures behind a build flag |
| A5 | Tools visible only when connected leave MCP sessions stale | Plan corrected: always listed, typed failure when unavailable |

## Stages

Jira: epic [AIW-405](https://blazity.atlassian.net/browse/AIW-405). Stage
tickets: S0 AIW-395, S1 AIW-406, S2 AIW-407, S4 AIW-408, S5 AIW-409, S3
AIW-410, S6 AIW-411, S7 AIW-396, S8 AIW-394, S9 AIW-412, S13 AIW-413, S10
AIW-414, S11 AIW-415, S12 AIW-416, S14 AIW-417, S15 AIW-418, R1 AIW-419.

Order and concurrency: S0, S1, S2 in sequence. S4 and S5 run in parallel after
S2. S3 and S6 run in parallel after S4 (their files are disjoint: MCP against
the dashboard). S7 after S6. Then S8, S9, S10, S11, S12 in sequence, because
each of them edits the engine's agent workflow or regenerates the same
catalogs. S14 after S12, R1 after S14.

Later phase (Jakub, 2026-09-18: Arthur and the existing providers first,
memory engines after): S13 after R1, S15 after S13.

Every stage that adds, moves, renames or deletes a `"use step"` or
`"use workflow"` file follows the drain rule of decision 5; the DoDs below say
"drain" where that applies.

Every stage also owns scenarios in
[the scenario catalogue](../qa/integrations-scenarios.md) (the "Stage" column
there). A stage's DoD always includes, beyond what its row says: each owned
scenario is held by a test written from the catalogue and seen failing once, or
by recorded production evidence, and the "Held by" cells are filled in the same
pull request. The skeptic's scenario pass at the start of the stage adds rows
before the executor writes tests.

| # | Stage | Seam | File scope | Tier | Autonomy | Skeptic | TDD | Delegation | DoD |
|---|---|---|---|---|---|---|---|---|---|
| S0 | The contract exists: an integration can be described in types, and the capability ports live in the SDK | SDK contract | `integrations/sdk/**`, `docs/adr/ADR-010-integrations.md`, `CONTEXT.md`, `pnpm-workspace.yaml`, re-export shims in `apps/worker/src/adapters/*/types.ts` | opus | tight | yes | conformance helper only | yes (inventory of what the five providers use from the worker) | `pnpm run typecheck` green; the inventory is attached to ADR-010 and every item maps to a context member or a stated reason it stays in core; a fixture integration type-checks against the manifest, the context (including `llm`) and each port; ADR-010 states decisions 1 to 20 with reasons; `pnpm run verify:changed` green |
| S1 | The build finds integrations: adding a folder adds a registry entry, and the gates hold the line | generator and gates | `scripts/gates/generate-*/**`, `scripts/gates/tiers.json`, `scripts/gates/boundaries.mjs`, the new core-reference gate and its allowlist, generated registries, `integrations/_template/**`, `integrations/_fixtures/**`, root and worker `package.json` scripts | opus | tight | no | yes | yes (fixtures) | `gen:integrations -- --check` fails stale and passes after generation; the fixture appears in registries only with the fixture flag; a planted core import of an integration and a planted provider literal in core each fail their gate with a readable message; conformance runs over all packages under zod 3 and the `zod4` alias; `pnpm run typecheck`; the gate suites under `pnpm run test:ci` |
| S2 | An integration can be connected, tested and stored, safely | connection resolution | `apps/worker/src/db/schema/integrations.ts`, `apps/worker/drizzle/00XX_integrations.sql`, `apps/worker/src/services/integrations/**`, `apps/worker/src/routes/api/v1/integrations/**`, `apps/worker/src/infra/secrets-crypto.ts`, integration types in `packages/contracts/api.ts` | opus | tight | yes | yes | no | Unit tests at the resolution seam: environment complete, environment partial (Failing, missing names), stored, stored prepared while environment is the source then switched, disabled under each source, missing key, key-id mismatch, version pinning with a secret-only change and with a config change, write refused when deployment and database environments differ, secret absent from every output; migration applies on pglite and through `pnpm db:migrate`; on demo: connect the fixture with a bad value (Failing with reason) then a good one (Connected), disable and enable, and read the logs for the secret |
| S4 | The engine decides what can run from the integration state | block contract resolver, generic step | `apps/worker/src/engine/definition/**`, the new generic integration step under `apps/worker/src/engine/steps/`, `apps/worker/src/engine/support/adapters.ts`, `apps/worker/src/services/manual-dispatch/resolve.ts`, dispatch preflight in `apps/worker/src/services/dispatch/**` | opus | tight | yes | yes | no | Resolver tests over declared deployments; publish of a workflow using an unavailable integration refused naming it; a dispatch for such a workflow produces a failed run with `integration_unavailable` and the ticket comment; a run in flight fails at its next use after a disable and after a reconfiguration, each with its reason; drain; guard tests green; engine canary green |
| S5 | Health reports integrations without core listing them | health collection | `apps/worker/src/services/system/**`, health types in `packages/contracts/api.ts`, `apps/dashboard/components/cockpit/screens/health.tsx` | opus | open | yes | yes (worker side) | no | A health scan on demo shows core checks unchanged and one section per integration, including Not connected and a partial environment naming its missing variables; the screen reads at desktop and phone width |
| S3 | An agent building workflows over MCP knows what integrations make possible, and nothing about their configuration | MCP contract | `apps/worker/src/mcp/tools/authoring-support.ts`, draft and run tool responses in `apps/worker/src/mcp/tools/**`, the contract snapshot, the MCP guard test | opus | tight | yes | yes | no | `(cd apps/worker && pnpm run mcp:contract:check)` green; `system.capabilities` lists exactly the blocks the editor palette shows for the same integration state; a draft saved over MCP with an unavailable integration's block gets the editor's issue naming it; a failed run read over MCP carries `integration_unavailable`; the guard test fails when an integration management tool is planted in the catalog; no MCP response carries integration configuration or secrets |
| S6 | An admin can connect an integration from the dashboard and see what it unlocked | dashboard over the integrations API | `apps/dashboard/app/(cockpit)/integrations/page.tsx` and the connection tab `apps/dashboard/app/(cockpit)/integrations/[id]/connection/**`, `apps/dashboard/components/cockpit/screens/integrations/**`, `apps/dashboard/app/api/integrations/**`, `apps/dashboard/components/cockpit/flow-editor/block-palette.ts`, the canvas warning component | opus | open | yes | no (component tests for logic) | no | On demo in a browser at desktop and phone width: connect the fixture with a wrong then a right value, see status, source and unlocks, prepare stored values while the environment is the source and switch, disable, watch the palette lose and regain the block without a reload, open a workflow using it and see the named warning with a link, publish refused; a member sees status and no controls; on a preview the write controls explain why they are unavailable |
| S7 | The sidebar separates core from integrations, and integration pages look native | dashboard chrome, host UI package | `apps/dashboard/components/cockpit/chrome.tsx`, `apps/dashboard/app/(cockpit)/cockpit-shell.tsx`, the integration area layout with its tabs `apps/dashboard/app/(cockpit)/integrations/[id]/layout.tsx` and contributed pages `apps/dashboard/app/(cockpit)/integrations/[id]/[page]/**` (not `connection/`, which is S6's), settings navigation, moved health and users routes, the host UI package, the Tailwind entry | opus | open | yes | no | no | On demo: core groups, a separator, the Integrations page entry, and an entry only for connected enabled integrations, each opening its area with horizontal tabs (its pages plus Connection); System health and Users under Settings with their old URLs redirecting; a fixture integration with two pages shows them as horizontal tabs in its section; groups collapse and the whole sidebar fits 1920x1080 without scrolling; a fixture page built from a host primitive and an arbitrary-value class renders styled at desktop and phone width; the boundaries gate accepts the host UI import and still rejects `@/components/ui` from an integration |
| S8 | Arthur is an integration, and core has never heard of it | the whole contract, first real use; `agent_tracing` | `integrations/arthur/**`; deletions across `apps/worker/src` (Arthur client, tracer wiring in `sandbox/agents/*`, `agent-sandbox.ts`, the Arthur task step in `prepare-workspace`, the injection block, evals collection, probes); the evals screen and nav in `apps/dashboard` | opus | open | yes | yes | no | Drain, total: zero running, awaiting or parked runs on production and demo, each awaiting run cancelled with a Jira comment (the removed `prepare_workspace` Arthur task step sits in every run that reached a sandbox; ADR-010, "The drain for this stage is total"); guard tests green; core-reference gate green for `arthur`; on production with Arthur connected: a real agent run with traces visible in Arthur and no API key in the run log, an injection check returning a typed verdict and failing closed on a flagged prompt, the Evals section present; after disabling Arthur (it stays environment-sourced): block gone from the palette, publish refused, dispatch failing with `integration_unavailable` |
| S9 | Slack is an integration and messaging is a capability | messaging port, webhook translation | `integrations/slack/**`; new core `send_message` block, which `send_slack_message` migrates into (decision 17, amended); `investigate` stays in core until S12 and reaches chat through the capability; `apps/worker/src/adapters/messaging/**`; `apps/worker/src/routes/webhooks/slack.post.ts` and the generic `/webhooks/[id]` route; Slack call sites in `apps/worker/src/engine/**` and `services/**` | opus | tight | yes | yes | no | Drain; guard tests green; recorded-payload tests for the slash command and message delivery; on production: a real run posts through the capability, the slash command still dispatches at the old URL, the research block returns synthesised findings; core-reference gate green for `slack` apart from the listed `investigate` rows and the leak review's credential pattern, each carrying its reason and its removal point |

S9 audit, 2026-09-21: a webhook for a **disabled** integration answers 202, dispatches nowhere and records `integration_disabled_ignored`, which is what keeps a provider from retrying and then switching the endpoint off; an unreadable or disconnected configuration answers 503, because in neither case can the sender be authenticated at all. The recorded-payload requirement is met by Slack's own published signed request (secret, timestamp, body and signature all authored by Slack, kept with its provenance beside the bytes), which our verifier accepts without computing anything: a capture from our own workspace would be no more independent and would carry a real signing secret to redact.

S9 impact completion, 2026-09-21: disconnect and a save that would move the connection fingerprint now read their cost before writing. The worker lists enabled definitions from deployed graphs through `integrationsUsedBy`, including a core `send_message` block whose active messaging provider is the integration, and counts live run claims on those definitions. The dashboard names the definitions and the measured count. A failed definition or run read stays unknown in both the copy and the confirmation label; it never becomes an empty list or zero.

| S13 | Memory is a capability with a built-in provider, shaped for any memory engine | memory port | `apps/worker/src/memory/**`, memory call sites in `apps/worker/src/engine/**`, callers of `apps/worker/src/db/repositories/memory.ts`, the dashboard memory screen's data source, memory MCP tools | opus | tight | yes | yes | no | The port is designed against the built-in document store and the published APIs of at least two external engines (Mem0 and Zep/Graphiti), and the stage report shows each engine's add, search, update and delete mapped onto it; drain if a step file changes; port tests with a fake store; on demo: an agent run writes and reads memory through the port with no behaviour change, the memory screen and its MCP tools read through the port, the active provider selection lists built-in as the only choice |
| S10 | Core talks to version control only through the capability, and GitLab is an integration | VCS port | `integrations/gitlab/**`; `apps/worker/src/adapters/vcs/**`; `apps/worker/src/engine/runtime/vcs-runtime.ts`, `pr-external-resources.ts`; `apps/worker/src/infra/vcs-config.ts`; `apps/worker/src/routes/webhooks/gitlab.post.ts`; GitLab call sites in `services/**`; the migration of decision 19 | opus | tight | yes | yes | no | Drain; guard tests green; recorded-payload tests for every GitLab event in use; importing a repository with an unregistered provider is refused by validation, not by a constraint error; on the GitLab dogfood project: a ticket run opens a merge request, a comment triggers the review path, a failed pipeline triggers the fix path; core-reference gate green for `gitlab` |
| S11 | GitHub is an integration | VCS port, second provider | `integrations/github/**`; GitHub parts of `apps/worker/src/adapters/vcs/**` and `infra/vcs-config.ts`; `apps/worker/src/routes/webhooks/github.post.ts`; `apps/worker/src/harness-profiles/github-skills.ts`; GitHub call sites in `services/**` | opus | tight | yes | yes | no | Drain; guard tests green; recorded-payload tests for every GitHub event in use; on production: a ticket run opens a pull request, a review comment triggers the fix path, a failed check triggers the autofix path, checks are created and completed, skills still load; core-reference gate green for `github` |
| S12 | Jira is an integration and the ticket lifecycle runs on the capability | issue tracker port | `integrations/jira/**`; `apps/worker/src/adapters/issue-tracker/**`; `apps/worker/src/services/triggers/jira/**`, `services/triggers/polling/**`, `services/dispatch/**`, `services/clarifications/**`, `services/approvals/**`, `services/tickets/**`, `services/run-lifecycle/**`, `services/manual-dispatch/**`, `services/mcp/**`; Jira references in `apps/worker/src/engine/**`; `apps/worker/src/routes/webhooks/jira.post.ts`; the issue tracker group in `packages/contracts/settings-registry.ts` | opus | tight | yes | yes | no | Drain; guard tests green; recorded-payload tests for the webhook and tests for the poll path; the stored column values on production are unchanged before and after the deploy; on production: a ticket moved into the AI column starts a run by webhook and by poll, a clarification answered in a comment resumes it, a failure posts its comment, plan approval works; the columns are edited as issue tracker settings; core-reference gate green for `jira` |
| S14 | A developer can add an integration from the guide alone | documentation and template | `docs/architecture/integrations.md`, `integrations/README.md`, `integrations/_template/**`, the scaffold script, `CONTEXT.md`, `docs/index.md`, the `AGENTS.md` routing row, a changelog entry | opus | open | yes | no | no | The docs status gate passes; the scaffold produces a package that passes conformance and typecheck untouched; a reader with no repository knowledge can name every step from manifest to connected integration; the guide covers the capability table, the one-step rule, the context, sources and secrets, dashboard pages with the host UI package, and MCP tools |
| S15 | An external memory engine written from the guide alone proves the guide | the guide as an interface | `integrations/<engine>/**` (Mem0 is the first candidate because it has a hosted API with an API key and an open source server; Zep/Graphiti is equally valid), guide corrections | opus | open | yes | yes | no | The executor receives only the guide and the SDK; every question they had to ask elsewhere becomes a guide fix in the same stage; on demo with the engine's key: memory switched to it, an agent run writes and reads memory there, switching back to built-in finds built-in memory unchanged (INT-061 to INT-064, INT-130) |
| R1 | The Arthur tenant runs on the new shape | release | release artefacts only | opus | tight | no | no | no | The tenant's operator is warned with the date; its parked and in-flight runs are listed and drained; the upgrade preflight passes; its workflow definitions are re-authored; its integrations show the environment as their source and Connected; one real ticket run completes end to end in the tenant |

S10 implementation audit, 2026-09-21: GitLab ships from
`integrations/gitlab` and core resolves VCS by repository through the
capability. The shared head and gate status contracts are provider-neutral,
trigger and repository provider ids are open registry values, and the database
migration drops the two provider checks without changing data. Import, save,
enable and activation now refuse an unregistered provider before persistence.
The existing webhook URL is served by the generic route, and published GitLab
merge request, pipeline and note payload examples cover every event in use.
Environment-backed connections, the legacy default project and the
single-provider bot-login fallback remain compatible. Local gates do not stand
in for the stage's GitLab dogfood run or the production drain; those remain
release evidence.

Corrected S10 drain, 2026-09-21: no step identity is added, removed, moved or
renamed. The total drain covers recorded inputs for
`blockPrTriggerRepositoriesWithSiblingsStep`, `blockFetchPrContextsStep`,
`blockPostPrCommentStep`, `blockPrepareWorkspacePreSandboxStep`,
`blockApprovedRepositoryScopeStep`, `blockPrepareWorkspaceProvisionStep`,
`runPreSandboxPhase`, `attachResearchRepositoriesStep`,
`captureDefaultBranchFilesStep`, `promoteRepositoryWriteScopeStep`,
`findWorkflowOwnedPullRequestForBranch`,
`createOrFindWorkflowOwnedPullRequest`, `fetchPullRequestChangeSetStep`,
`postReviewLedgerFailureNoteStep`, `settleReviewLedgerStep`,
`publishTrustedWorkspaceFromSandbox`, `publishPrFixStep`, `createPrCheckStep`,
`completePrCheckStep`, `postPrReviewStep`, `closeTerminalPrChecksStep`,
`verifySourcePullRequestStep`, `verifyPullRequestStep` and
`verifyFinalizedBranchHeadStep`. It also covers the recorded results of
`blockFetchPrContextsStep`, `verifySourcePullRequestStep` and
`verifyPullRequestStep`: their pull request head data now records `checks`
instead of the retired pipeline and check-run fields. Replaying any earlier
record across this boundary is unsupported, so the branch requires a total
drain before merge.

S11 implementation audit, 2026-09-21: GitHub ships from `integrations/github`
and core resolves every version control call through the capability.
`createVCSForRepository` is deleted rather than generalised: core holds no
provider adapter, no provider credential and no branch on a provider name, and
a repository whose provider no integration serves is refused by name. The App
private key is accepted both as the downloaded `.pem` and as its base64 form
and refused with a sentence when it is neither, before the connection is
activated. `/webhooks/github` keeps its URL and its signature scheme, served by
the generic route. Published GitHub payload examples cover pull request opened,
synchronize and closed, check run completed and failed, review submitted,
review comment created, issue comment created and repository renamed, each with
its source URL, pinned revision and digest beside the bytes. The legacy
environment, the `GITHUB_OWNER`/`GITHUB_REPO` pair and the single-provider
`VCS_BOT_LOGIN` remain compatible. Two boot-time checks became Integrations
page rows, which is the same trade S10 made. Local gates do not stand in for
the stage's production run or the drain; those remain release evidence.

S11 drain, 2026-09-21: no step identity is added, removed, moved or renamed,
and no step's recorded input or result changes shape. Two recorded VALUES
change, and a run replaying across either boundary is unsupported:

- The opaque handle on a failed check. A `check_run` delivery whose `app`
  carries no slug used to mint `owner: <sender login>` while the adapter
  reading the same check back minted `owner: ""`, so the two never compared
  equal and the check bound to nothing. Both are `check.app?.slug ?? ""` now.
  Every step whose recorded input carries a `trigger_pr_checks_failed` payload
  holds handles in the old shape: `acknowledgePrTriggerDispatchStep`,
  `blockPrTriggerRepositoriesWithSiblingsStep` and `blockFetchPrContextsStep`.
- `PrePrCheckFailure.provider` on the checks-budget record
  (`engine/blocks/pre-pr-checks.ts`), which was `"github"` when no repository
  was skipped and is the empty string now.

This branch requires a total drain before it merges in any case, under the
protocol above, so neither is a new drain event; both are listed because the
list has to stay honest about what a replay would read.

S11 connection shape, 2026-09-21: the pinned connection shape now carries
GitHub's eight fields (`services/integrations/connection-shape.test.ts`
snapshot). No existing pin moves, because core's GitHub was not an integration
and nothing pinned it; a run started before this branch carries no GitHub pin
at all and proceeds against current settings, which is the documented behaviour
for a row written before pins existed. No GitHub secret is marked `identity`:
the App and installation ids already pin the account by value, so rotating the
private key is a rotation rather than a different connection.

S11 late decisions, 2026-09-21:

- A verified App webhook that has never delivered reads LIVE, not degraded,
  which is what core's own check said before the move. Whether anything
  actually arrived here is the separate `webhook-delivery` row, so a freshly
  connected App no longer shows an amber row nobody can act on.
- The core-reference gate now excludes `test-support.ts` modules wherever they
  sit, alongside the `src/test-support/` tree it already excluded. A shared
  test fixture naming a provider is the subject of a test, not a coupling in
  the product; the alternative was a fixture provider id that silently detached
  six executor suites from the records they compare against.
- `@octokit/rest` joined the workspace catalog, because two packages now
  depend on it and the deps gate refuses a shared dependency with a specifier
  of its own.

S11 review round, 2026-09-22 (six defects, all in what the stage deleted):

- The two expansion steps are terminal again on a provider that did not answer
  (`engine/steps/phase.ts`). The directory they read before S11 threw; dropping
  `listing.failures` told a person their repository was not on the catalog when
  a GitHub 401 simply hid it.
- The SDK's `legacyGate` gained `pusher`, and the route reads it instead of
  `workflowInput.author`. The author of a pull request this product opened is
  always our own account, so the gate was skipped on every human push.
- A delivery's answer now carries what core did with it (`dispatched`,
  `ignored` with the dispatch's own reason), which is what the deleted GitHub
  route recorded in the provider's delivery log.
- `IntegrationContext.webhookUrl` tells an integration where core receives its
  deliveries, and GitHub's webhook check compares it with the URL the App
  holds. An App pointed at another deployment was invisible for a week.
- Every example path is scoped to what the caller holds (a catalog, a listing,
  the keys an answer named) rather than to the first provider the build ships.
- `repositoryKeySchema` states its rule instead of showing
  `"provider:owner/name"`; that package may not read the registry, so it may
  not invent a provider either.
- At capacity a delivery is answered 2xx with `at_capacity` rather than 503:
  GitLab switches a webhook off after a few consecutive failures, which would
  trade one missed event for every later one. A dispatch error still answers
  503.
- The webhook route fails closed when the automation account cannot be read,
  the way the first settings read already does.

S12 round three, 2026-09-22: the poll containment had a hole above itself and
this round's own fixes carried two new failure paths. Fixed and covered:

- Clarification expiry runs above the ticket half, by design, and was
  unguarded. A database blip inside it killed the whole tick, which is the
  exact failure the containment reports as contained. It is best-effort now,
  like every other housekeeping phase in that pass.
- An unexpected THROW out of the tracker resolution left `createAdapters`
  entirely, and the poller builds its adapters before its first phase. It
  lands on the same point-of-use getter as every other refusal now, carrying
  what threw. That also answers `usable.ts`: only its two database reads are
  guarded, and a module load failure inside it reaches the caller. Containing
  it at the caller is right either way, because a caller that never touches
  the tracker should not care what failed inside the resolution.
- The AI review destination cache was keyed on the column name alone. That was
  safe while the transition id came from an environment variable; since S12 it
  comes from a connection read that can fail for one tick, so a degraded
  resolution was cached for the life of the process. The key now covers the
  transition id, absence included, and the reconciler logs the degraded read
  rather than swallowing it.
- Completing a bare column name now reads the settings guarded, matches
  trimmed and case-insensitively as the reconciler does, and completes only
  when EXACTLY ONE column answers to the name. Two columns answering meant the
  first match won, and an operator renaming the AI column to the review
  column's old name would have sent a finished run's ticket back into the AI
  column for the poller to start again.

S12 round four, 2026-09-22, both on the operation this branch exists to make
possible, an admin repointing a connection:

- The AI review destination cache is keyed on the tracker's identity as well
  as the column and the transition id. Repointing Jira on a warm worker left
  every cached status id belonging to the old instance, and the reconciler
  read a ticket sitting in AI Review as one that had left the AI column and
  cancelled a healthy run. `resetAiReviewDestinationCache` has only test
  callers and was never going to save it; a key that covers what the value
  depends on needs nobody to remember anything.
- The ticket half of a poll pass is contained as a whole rather than at the
  board read inside it. `createAdapters` freezes its resolution at the top of
  the pass and the board is read later, so a tracker connected between the two
  threw from the middle of the half and took the housekeeping with it. Two
  tests now cover the two doors.
- One policy for the tracker wiring read in `run-lifecycle/reconcile.ts`: it
  throws, at every site. The half is contained, so a failed read costs the
  reconciler and nothing else. The fallback it replaced decided the review
  destination by name alone, which misses on a localized board and cancels a
  run that is finishing; a silent degrade there is worse than a skipped pass.
- The two dropped board reads in `steps/ticket-transition-step.ts` log
  `ticket_move_board_read_unavailable`.

Answered, not changed: `resolveActiveIssueTracker` is contained at
`createAdapters` alone because that is the one caller reached before anybody
decided they needed a tracker. The five callers that let a throw through are
each called by something already committed to ticket work, where a fallback
would be a wrong answer rather than a smaller one; their containment belongs
at the ticket half and the webhook handler, which is where it now is. The
function's own doc comment says so.

S12 claims withdrawn, 2026-09-22: "one derivation" means one derivation for
every key this build WRITES. Two places reconstruct a key an earlier build
wrote and spell `jira` themselves, because the word those rows carry is a
historical fact rather than this deployment's configuration:
`db/repositories/clarifications.ts` and `engine/agent-workflow.ts`, the latter
in workflow scope where no connection can be read at all. The core-reference
gate allowlists exactly these two with that reason. The earlier report also
said clarification expiry had been moved above the ticket half; it had always
been there and was not moved. It is guarded where it stands.

S12 evidence, 2026-09-22, two claims corrected after the gate:

- The characterisation suite passed unedited across the rewrite, but nobody can
  check that: the file was never committed before the rewrite, so no record of
  it exists from before. It rests on the author's word alone and should be read
  that way. For the rest of this branch, characterisation tests are committed
  BEFORE the rewrite they pin, which makes the property provable.
- The five recorded payloads are Zulip's open source Jira webhook fixtures at a
  pinned commit, not deliveries this deployment received. Each `.source.txt`
  says so with its URL, revision, retrieval date and digest, and the suite
  recomputes every digest. They are real Jira Cloud bytes; they are not ours.

S12 implementation audit, 2026-09-22: Jira ships from `integrations/jira` and
core reaches every ticket through the `issue_tracker` capability. The
integration owns the HMAC verification, Jira's own delivery envelope, the
project comparison and the "was that move ours" question; core keeps what a
ticket move means for a run, which is the columns, the claim, dispatch, cancel,
resume and plan approval. A new reception kind, `ticket_events`, carries the
result, because the VCS-shaped `trigger_events` says nothing about a status
change. `/webhooks/jira` keeps its URL and its signature scheme, served by the
generic route, which records each delivery for the `webhook-delivery` check it
already wrote for every other integration. Recorded payloads are five real Jira
Cloud deliveries, each with its source URL, pinned revision, retrieval date and
digest beside the bytes, and the first test re-computes every digest. Core's
`jira.api` and `jira.webhook-delivery` probes are gone; the integration reports
Account access, Project access and Webhook registration, and `jira` leaves
`CORE_HEALTH_SECTION_IDS` in the same change, which is what lets the package
take the name.

S12 boot failure, 2026-09-22: the worker refused to start without
`JIRA_BASE_URL`, `JIRA_API_TOKEN` and `JIRA_PROJECT_KEY`, and a deployment with
no issue tracker is a legitimate state now, so that failure had to move rather
than disappear. It is the integration's Project access check: a project key
that names nothing, or that the token account cannot see, reads Down on the
Health screen and says which value to fix, rather than every delivery being
ignored in silence as belonging to another project. The connection test refuses
to save such a connection at all.

S12 drain, 2026-09-22: no step identity is added, removed, moved or renamed.
The 158 `"use step"` identities (module path plus function name) are
byte-identical to the ones on the branch's start commit, checked by extracting
the pair from every step-bearing file at `0486b82c` and in the tree. One
recorded RESULT gains a field:

- `runStartSettingsStep` records an optional `tracker` (the site and up to
  three transition ids). A run suspended before this change replays a result
  without it, so every transition id it builds a move from is absent. That is
  NOT benign on a board that reaches a column only by a named transition: the
  move by column name finds nothing and the ticket is stranded at the end of an
  otherwise successful run. A bare column name is therefore completed against
  the current board in `steps/ticket-transition-step.ts`, which runs in the
  worker and can read the connection, and only for a name that board still
  recognises. The ticket link is the part of absence that really is benign: it
  is dropped.

THE TRACKER IS NOT PINNED, and an earlier version of this paragraph said it
was. `resolveActiveIssueTracker` can compare a recorded pin, but no caller in
core passes one: every tracker call reaches `createAdapters()` without pins, so
the comparison does not run in production. An absent or empty pin set also
means "nothing holds this run" here, exactly as `hasRecordedIntegrationPins`
states for the VCS side, so a run whose row predates
`workflow_runs.integration_pins` proceeds against the tracker as it is
configured now rather than refusing. Nothing about the merge may rest on that
check. The branch still requires the total drain the protocol above states, for
the reasons S10 and S11 recorded.

S13 drain, 2026-09-22: no step identity is added, removed, moved or renamed.
The 67 files carrying `"use step"` are the same 67 at `3c3bc7ca`, and the 106
`(module path, function name)` pairs an extraction over those files finds are
identical before and after. Five of those files changed, none in a way that
moves an identity: `engine/steps/memory-steps.ts`,
`engine/steps/repo-memory-steps.ts`, `engine/steps/repo-seed-steps.ts`,
`engine/blocks/prepare-workspace/execute.ts` and `engine/agent-workflow.ts`.

FOUR RECORDED RESULTS GAIN A FIELD, all optional, all absent on a result stored
before this change, and absent means "memory answered" in every one of them.
A run suspended inside any of these replays its stored result and behaves
exactly as it did, because nothing downstream branches on the new field except
to record it:

- `hydrateWorkspaceMemoryStep` and `persistWorkspaceMemoryStep` gain
  `unavailable`, the provider's reason. `source: "none"` and
  `persisted: false` used to mean both "nothing was stored for this subject"
  and "memory could not be reached"; they now mean only the first.
- `seedRepoMemoryStep` gains `unavailable` for the same reason.
- `distillRepoMemoryStep` gains `unavailable` and a new `skipped` value,
  `memory_unavailable`. A replayed result carrying `store_failed` still reads
  as it always did.

ONE RECORDED RESULT CHANGES SHAPE: `loadRepoMemorySourcesStep` answered
`EffectivePromptMemorySource[]` and now answers `{ sources, unavailable? }`. A
run suspended inside it replays an ARRAY, and reading `.sources` off that would
hand the prompt compiler `undefined` outside the catch that guards this call.
The caller therefore accepts both shapes (`Array.isArray(loaded) ? loaded :
loaded.sources` in `engine/agent-workflow.ts`) and reads the older one as
"memory answered", which it did. It is still a drain reason and the branch
requires the total drain the protocol above states, for the reasons S10 and S11
recorded; the compatibility is what keeps a replay from failing before that
drain happens.

NOTHING PINS THE MEMORY PROVIDER TODAY. `activeMemory(pins)` can compare a
recorded pin and no caller passes one, because threading pins into a memory
call would change the recorded INPUT shape of a `"use step"` function, which is
a strictly worse drain event than this stage otherwise needs. The comparison is
therefore wired and unused in production, exactly as S12 recorded for the
tracker, and nothing about the merge may rest on it operating. It is also why
the built-in provider is resolved BEFORE any pin comparison: on a deployment
with no memory integration a run's pins name other integrations, and comparing
them would read as "memory moved" on every run of every default deployment.

S13 scope not taken, 2026-09-22: routing memory
(`engine/pre-sandbox/steps/repo-selection.ts`) still reads and writes
`db/repositories/memory.ts` directly and is NOT on the port. Its document is a
structured index of label-to-repository answers with corroborating ticket keys,
which core parses and matches to decide whether to ask a human; putting it
behind a prose port would either export the routing schema into the SDK or lose
the compare-and-swap that keeps two runs from overwriting each other's answers.
The cost is real and is written down rather than discovered: a deployment that
connects a memory engine keeps its routing answers in the built-in store, so
that one scope is split across two providers. Both switches that gate routing
(`ENABLE_REPO_MEMORY` and `ENABLE_REPO_ROUTING_MEMORY`) default to false, so no
default deployment is in that state.

S12 connection shape, 2026-09-22: the pinned connection shape gains Jira's
seven fields (`services/integrations/connection-shape.test.ts` snapshot, +68
lines). No existing integration's fingerprint changes. `apiToken` is
deliberately NOT marked `identity`: the site URL already names which Jira this
is, so rotating the token is a rotation rather than a different connection.

S12 late decisions, 2026-09-22:

- `getCurrentUserAccountId` is required on the port, not optional. Without it a
  deployment cannot tell its own ticket moves from a person's, so the product
  cancels its own runs the moment it finishes them and nothing says why. The
  type holds for an integration compiled here and `resolveActiveIssueTracker`
  holds for one that was not, which the SDK allows.
- `createAdapters` became asynchronous rather than handing back a lazy proxy. A
  proxy answers a function for every name, and eighteen places in core ask
  whether this tracker can do an optional thing; every one of them would have
  started answering yes. The refusal is raised on `adapters.issueTracker`
  instead of when the set is built, so a deployment with no tracker still gets
  its run registry, its VCS adapter and its notifications.
- `ticketSubject(ticketKey)` is the single derivation of `ticket:jira:<KEY>`,
  taken from the id of the integration serving the capability. That id is
  permanently `jira` because the string is in `active_runs`; changing it later
  is a migration over run history, and the manifest says so.
- The `investigate` block's two provider parameters became capability
  vocabulary (`providers` to `sources`, `jira` to `issue_tracker`,
  `jiraJqlTemplate` to `issueTrackerQueryTemplate`). The compatibility map goes
  with R1's one-off rewrite, the same way the `send_slack_message` alias does.

## Backlog mapping

| Existing issue | Fate |
|---|---|
| AIW-405 (new epic) | Integrations: every third party as a package that unlocks blocks, screens and tools once connected; every stage is its child |
| AIW-395 plugin architecture | Re-cut as S0, the contract; the whole architecture now lives in the epic |
| AIW-394 Arthur as a third-party settings tab | Re-cut as S8 |
| AIW-396 sidebar regrouping, health and users under settings | Re-cut as S7 |
| AIW-290 feature-flag dashboard tabs, group non-core | Closed as duplicate of AIW-396 |
| AIW-294 injection check typed output and halt | S8 |
| AIW-19 prompt injection detection | Closed as delivered; remaining work in AIW-287, AIW-294 and S8 |
| AIW-14 Linear integration | Blocked by S12 (AIW-416), first candidate after it |
| AIW-393 editable memory | Independent; lands on the memory port after S13 if it has not shipped before |
| AIW-376 MCP parity for repository catalog and settings | Unaffected: existing MCP tools stay as they are; decision 15 covers integrations only |
| AIW-297 unify input and parameter naming for MCP | After S4, since block catalogs change shape |
| AIW-293 workflow builder fixes (14 children) | Held until S4 and S6; the blocks they touch move |
| AIW-392 sandbox environment forwarding redesign | Prerequisite of the `agent_tools` slot, separate plan |
