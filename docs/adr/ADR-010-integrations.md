Status: current
Last-verified: 2026-09-18

# ADR-010: Integrations

Decision status: Accepted

Source: the implementation decisions of
[docs/plans/2026-09-18-integrations.md](../plans/2026-09-18-integrations.md),
frozen in stage S0 (AIW-395) as the package `@integrations/sdk` under
`integrations/sdk`. The plan carries the stage table and the user stories;
this record carries the rules a reviewer applies, their reasons, and every
later change to the contract.

## Context

Every third party the product talks to (Jira, Slack, GitHub, GitLab, Arthur)
is wired into core by hand. Connecting one means editing environment
variables and redeploying, because settings hold no credentials
(`packages/contracts/settings-registry.ts:4-8`). The editor learns what can
run from provider conditions written in the middle of the engine
(`apps/worker/src/engine/definition/block-contract-resolver.ts:78-194`). Non-test
worker files outside the adapter directories name Jira 14 times, Arthur 14,
GitHub 9, Slack 7 and GitLab 7 (the plan's recon). One block, `investigate`, reads Jira through
the port and calls Slack directly
(`apps/worker/src/engine/blocks/investigate/execute.ts:345-433`), and the
Arthur check skips when Arthur is not configured
(`apps/worker/src/engine/blocks/arthur-injection-check/execute.ts:98-101`).
Nobody outside the core team can add a provider: there is no place, no
contract and no guide.

What constrains the answer, all true today:

- The Workflow DevKit discovers steps only under `apps/worker/src`, and a
  step's identity is its module path plus its function name
  (ADR-001, "The engine as a workspace package"). Step code from anywhere
  else is never found, and moving a step strands the runs suspended in it.
- The DevKit's flow bundle fails the Vercel build on any Node module in
  workflow scope, and the dashboard bundles for the browser.
- Production resolves zod 4 while the workspace pins zod 3
  (`pnpm-workspace.yaml:16-21`); a one-argument `z.record` passed every gate
  and took production down.
- An invocation has a 300 s ceiling (`apps/worker/src/infra/llm.ts:14-19`),
  and research blocks synthesise with a model today
  (`apps/worker/src/engine/blocks/investigate/execute.ts:298,477,532`).
- Preview deployments read the production database, and production runs
  neon-http, which has no interactive transactions.

## Decision

### The plan's decisions

1. **One word.** The concept is an *integration* everywhere (interface, code,
   MCP, docs). A seam an integration can fill is an *integration capability*,
   `IntegrationCapability*` in code, distinct from the model catalog's
   `HarnessCapability*`. Reason: two words for one thing split every search,
   and "capability" already meant something in the harness catalog.
2. **One package per integration** under a top-level `integrations/` workspace
   folder: `integrations/sdk` is the contract; `integrations/<id>` has a
   `manifest` entry (pure data, no Node modules), a `worker` entry (the
   runtime) and an optional `dashboard` entry; `integrations/_template` is
   what the scaffold copies. Packages are TypeScript sources with `main`,
   `types` and `exports` on `.ts`, exactly like `packages/*`, with their own
   `typecheck` script. Reason: that shape is proven on Vercel for Nitro, Next
   and the DevKit bundles without `transpilePackages` or `externals.inline`,
   and a package without the script drops out of `pnpm -r typecheck`. The
   three entries exist because the three bundles that read an integration
   (browser, workflow scope, server) tolerate different code.
3. **Registration is generated.** The block catalog generator grows into an
   integration generator that writes committed registries, with `--check`
   inside `build`. Reason: a hand-kept list is the drift this plan removes.
4. **No runtime code loading.** Integrations are compiled in; a deployment
   decides which are connected. Reason: the DevKit would not find step code
   installed at runtime, and loading third-party code at runtime is a security
   surface nobody needs.
5. **Integration code carries no `"use step"`.** Core owns one generic
   integration step that runs any integration block executor; an integration
   block is exactly one step. Reason: step identity is path plus function
   name, so directives inside integration packages would strand runs whenever
   a package moved. The migration itself changes step files, so every stage
   that adds, moves, renames or deletes a `"use step"` or `"use workflow"`
   file drains the runs in flight through it first.
6. **The context is the only thing an integration receives**: its resolved
   connection, an HTTP client with timeout, retry and redaction, a logger, the
   run and node identity while a block executes, the capabilities it declared,
   and a core-owned `llm`. No database, no process environment, no worker
   import. Reason: anything more couples integrations to worker internals and
   every internal change becomes a change to every integration. The context
   was designed from the inventory in Appendix A, not from first principles;
   after S0 it changes only additively, recorded in the change log below. The
   one exception is a row in the debt table: while a port's only
   implementations are core's own providers, the stage that owns the row may
   change that signature, and it writes the change into the change log. Once a
   port has an implementation outside this repository, even that stops.
7. **Capabilities**, with fixed ids and cardinality:

   | Capability | Port | Cardinality | Designed |
   |---|---|---|---|
   | `issue_tracker` | `IssueTrackerAdapter` | one active | S0 (moved) |
   | `vcs` | `VCSAdapter` | many, chosen per repository | S0 (moved) |
   | `messaging` | `MessagingAdapter` | one active | S0 (moved) |
   | `memory` | reserved | one active | S13 |
   | `agent_tracing` | reserved | many | S8 |
   | `agent_tools` | reserved | many | a later plan, after AIW-392 |

   Agent and LLM providers stay with the harness profile and the model
   catalog (ADR-006). Reason: these are the seams core has or needs; a
   reserved id lets core name the seam without guessing its shape.
   `agent_tracing` is the one declared exception to "secrets never leave the
   server": a secret it hands to a sandbox is declared in the manifest and
   redacted from run logs and traces.
8. **Webhooks** reach one generic route `/webhooks/[id]`, so the URLs
   providers already call keep working. A handler verifies the request and
   returns normalized core events; core dispatches. An event for a disabled
   integration is accepted, recorded as ignored with the reason, and
   dispatched nowhere. Reason: dispatch rules (capacity, ownership, stale
   heads) are core's and must not be reimplemented per provider; accepting
   the event stops the provider from retrying or disabling the hook.
9. **Connection state.** One source per integration, chosen explicitly: its
   declared environment variables or values stored from the dashboard. With
   nothing stored, a complete environment is the source, so running
   deployments need no action; a partial environment is Failing and names the
   missing variables. Only connection values come from the environment;
   operator behaviour (Jira columns, a Slack channel) is stored settings.
   Disable is a stored flag read live. A run pins a connection version,
   follows secret-only rotations and fails with `reconfigured` on a config
   change. Secrets are encrypted under `INTEGRATION_SECRETS_KEY` with a key id,
   never leave the server, and writes are refused on a deployment whose
   environment is not the database's. Reason: each rule answers a failure the
   pre-mortem found (a surprise override in production, rotation as an outage,
   a preview disabling production, a site mixed with another site's token).
10. **Built-ins live in core.** An implementation that needs core storage,
    such as built-in memory, is a core module registered as a provider, not an
    `integrations/*` package. Reason: an integration gets no database.
11. **Availability comes from the catalog.** The block contract resolver keeps
    its pure shape; its context becomes integration states and capability
    providers, and "this block needs integration X or capability Y" comes from
    the generated catalog. Reason: provider conditions written in core are
    what made every provider a special case.
12. **Unavailable is loud.** A run that needs a disconnected or disabled
    integration fails with `integration_unavailable` naming it and a reason;
    nothing is skipped, and the injection check fails closed. Memory is the
    one exception: a run continues without it and says so. Reason: a skipped
    safety check is worse than a failed run, and failing every run because an
    optional memory engine is down would make it the product's single point
    of failure.
13. **The editor** shows core blocks whose capabilities are provided and the
    blocks of connected, enabled integrations under the integration's name,
    and refuses to publish a workflow that uses an unavailable one. Reason:
    authors must learn about a missing integration before a run does.
14. **The sidebar** puts core groups first, then an Integrations separator,
    the Integrations page and one entry per connected, enabled integration,
    whose area has its pages and a Connection tab. Reason: third-party screens
    must not sit among core screens whether or not the provider exists.
15. **MCP covers what workflows can do, nothing more.** No integration
    management tool, no credential through MCP; `system.capabilities` reports
    connected integrations and the blocks they unlock, computed by the same
    resolver as the editor. Reason: a token pasted into a chat lands in the
    model's context and its provider's logs.
16. **Gates.** Nothing outside the generated registries imports an
    integration; an integration imports only `@integrations/sdk`,
    `@shared/contracts` and its own dependencies; integrations never import
    each other; conformance runs over every package under zod 3 and the
    production `zod4`; core naming a provider is a gate with a reasoned
    allowlist. The SDK re-exports `z`. Reason: the boundaries must hold
    without a reviewer noticing, and an integration picking its own zod would
    reopen the zod 4 incident.
17. **No backward compatibility for development data.** Removed blocks are
    deleted, not aliased, and the definitions using them are re-authored;
    runs in flight follow the drain rule. Reason: nobody depends on them, and
    aliases would keep provider names in core forever.
18. **Integration screens look like the product**: a `dashboard` entry may
    import a host UI package the gate allows, and Tailwind scans
    `integrations/*/dashboard`. Reason: Tailwind v4 does not scan workspace
    packages, and a page reaching for `@/components/ui` would couple the
    integration to the dashboard's internals.
19. **The repository provider is validated against the registry**, replacing
    the `github`/`gitlab` CHECK constraints in S10. Reason: a third VCS
    integration written from the guide would otherwise pass conformance and
    fail on import.
20. **Fixtures stay out of production**: the test integration lives in
    `integrations/_fixtures/*` and is generated only under a build flag that
    CI and the demo set. Reason: a fixture must never appear to production or
    the Arthur tenant.

### What S0 decided inside that frame

These were open to the S0 executor. Each is a two-way door until an
integration package depends on it.

- **Layout of the SDK.** Flat, like `packages/harness`: `capabilities.ts`,
  `manifest.ts`, `context.ts`, `runtime.ts`, `errors.ts`, `conformance.ts`,
  the three port files, and a fixture integration (`fixture-manifest.ts`,
  `fixture-runtime.ts`) that the package typecheck compiles. The fixture is
  not exported; it is the type-level evidence.
- **Inference.** `defineIntegration` takes a `const` type parameter, so ids,
  field keys, block types and capability ids stay literals.
  `defineIntegrationRuntime(manifest, {...})` then requires exactly one
  executor per declared block, one adapter factory per declared capability
  and one probe per declared health check, and types each executor's params
  (the zod output), inputs, context and output from its block.
- **Declare to receive.** A block's `requires` (capabilities, `llm`) is both
  what the editor checks for availability and what the executor's context
  contains. A capability or `llm` a block did not declare is absent from its
  context type, so a block cannot use something the editor did not check.
  `run`, `llm` and `capabilities` exist only in the block context. Everything
  else (a capability adapter, a connection test, a health probe) receives the
  same `IntegrationContext`: the connection, `http`, `log` and a `signal`. The
  adapter gets the signal too, so a capability called from a webhook route
  cannot outlive the route's own deadline.
- **Widening a name is refused at the manifest.** Every later check rests on
  literal types, so a manifest that annotated a block `: IntegrationBlockManifest`
  or built its fields elsewhere would silently switch them off: `blocks: {}`
  and a misspelled `ctx.connection` key would both compile.
  `defineIntegration` and `defineIntegrationBlock` refuse a widened id, block
  type or field key, and the refusal carries the sentence that says what to do.
- **A block's required output fields are typed from its manifest**, through
  the same small value-schema mapping the inputs use, so a block that promises
  downstream bindings a field cannot omit it or give it another type. The
  optional properties stay under the catalog's JSON shape; typing them too
  would fight the `BlockOutput` index signature for no failure anybody has met.
- **Reserved slots are `never`.** A reserved capability id is not a member of
  the providable union, so declaring it or passing an adapter for it does not
  compile, and conformance refuses it with the stage that designs it. The
  runtime's `webhook` (S9) and `api` (S8, the handlers an integration's pages
  read) are optional properties typed `never`. The React side of pages is
  S7's; the manifest declares a page's id and label now so the card and the
  sidebar can say what connecting unlocks.
- **Webhooks are reserved, not defined.** The trigger cluster has a
  normalized event only for pull requests (`TriggerEvent` in
  `packages/contracts/trigger-events.ts:37`, closed to `github | gitlab`);
  ticket moves and slash commands have none, and Slack's handler depends on
  acknowledging within the request (`waitUntil`,
  `apps/worker/src/services/slack/handle-slash-command.ts:165`). A contract
  cut from pull request events alone would be cut to fit VCS, so S9 designs
  it and starts from `TriggerEvent`.
- **HTTP is `fetch`.** `ctx.http.fetch` has the standard signature (proved by
  a type assertion in the fixture), so it can be handed to a provider SDK that
  takes a custom fetch (Octokit does). Defaults are exported constants,
  `INTEGRATION_HTTP_DEFAULTS`, so the contract and core's implementation read
  one number: 30 s per attempt, 2 retries, and only for a read (GET, HEAD,
  OPTIONS), with `Retry-After` honoured up to 30 s. A PUT or a DELETE is a
  write at these providers (a GitLab merge or rebase, a GitHub file commit),
  and repeating one after an ambiguous 5xx reports a conflict for work that
  landed, so nothing else is retried unless the caller asks. A non-2xx
  response is returned, not thrown.
- **The logger keeps pino's argument order** (fields, then event). Reason:
  every provider module being moved logs that way, so the moves in S8 to S12
  stay mechanical, and core can back it with a pino child logger.
- **`llm.generateObject` takes a zod schema** and resolves with the parsed
  output. Core chooses the model (the run's default) and records usage
  against the block. Core can convert either zod major to JSON schema (the AI
  SDK's `zodSchema` handles both). There is no model parameter: model choice
  belongs to the harness and model catalog.
- **"Do not retry" is `FatalError` from the SDK**, whose `name` is
  `FatalError`. The DevKit decides fatality with `FatalError.is`, which checks
  the name only (`@workflow/errors` 4.2.1, called from the step handler of
  `@workflow/core` 4.8.0), so the SDK's error stops retries wherever it is
  thrown with no translation, and the port's error contract is what the
  GitHub and GitLab adapters already throw. The pin is
  `apps/worker/src/adapters/vcs/types.test.ts`: a DevKit upgrade that changes
  the check turns it red. A block's returned `failed` outcome is an expected
  failure with a message for people.
- **Core never re-runs a block executor that has started.** The DevKit retries
  a step three times by default and the limit is a property of the step
  function, so one generic step would impose one policy on every integration
  block, and a block that posted a comment and then threw would post it twice.
  S4's generic step therefore sets `maxRetries` to 0, the way core's own
  side-effecting steps already do
  (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts:297,322`).
  Retrying a transient failure is the integration's own business, through
  `ctx.http`. There is no per-block retry flag: nobody has asked for one, and
  adding one later is additive.
- **Core rethrows run-control errors.** Integration code never recognises a
  cancelled run or an exhausted budget. The generic step records a
  run-control error when it raises one through the context and raises it
  again after the executor settles, so an executor that catches everything
  cannot turn a cancellation into a success or an ordinary failure. This is a
  requirement on S4's generic step. `ctx.signal` aborts on cancellation, on
  budget and near the invocation ceiling; `http` and `llm` are bound to it.
- **An integration whose fields are all optional must not read Connected by
  itself.** A manifest may declare only optional fields, and a complete
  environment would then be vacuously complete on every deployment, so a card
  would say "Connected (environment)" although nobody connected anything. The
  rule for S2: the environment is the source only when at least one declared
  variable is actually set; otherwise the integration is Not connected.
- **Connection fields.** Every field names its environment variable, states
  `secret` (no default), and may be `optional`, have a `default` (never a
  secret) and a `format` (`text`, `multiline`, `url`, `integer`). `integer`
  reaches the integration as a number, which keeps today's validation of
  `GITHUB_APP_ID` (`apps/worker/src/infra/runtime-env.ts:34`); `default`
  keeps `GITLAB_HOST` defaulting to `https://gitlab.com` (`:44`) and the Slack
  bot name (`:50`). There are no environment aliases:
  `VCS_BOT_LOGIN` is read by both VCS providers and applies only when one
  provider is configured
  (`apps/worker/src/adapters/vcs/vcs-bot-identity.ts:11-23`), which is a rule
  across integrations, not a property of one field. S10 keeps it in core or
  retires it.
- **Identity rules.** An id is 3 to 32 lowercase letters and digits, starting
  with a letter, and not a word core already uses (`RESERVED_INTEGRATION_IDS`:
  capability ids, the core routes `/webhooks/custom` and `/webhooks/resend`,
  core screens and concepts). No underscore, so a block type
  `<id>_<snake_case>` names its integration unambiguously. A page id is a
  slug and never `connection`, the core tab.
- **The two review ledger limits moved with the VCS port**
  (`REVIEW_LEDGER_MAX_WORK_ITEMS`, `REVIEW_LEDGER_MAX_CONTEXT_THREADS`),
  because an adapter applies them when it builds the feed
  (`apps/worker/src/adapters/vcs/github.ts:1283`, `gitlab.ts:341`).
- **What stayed in the worker's VCS file:** the optional provider extensions
  (gate status, rich gate status, pull request files, reviews, manual
  dispatch snapshots), because `GateStatusRef` names GitHub and GitLab and
  generalizing it changes a signature; the review ledger's engine types; and
  the finding digest, which needs `node:crypto`. The worker files re-export
  every moved name with the same kind (type or value), checked with the
  compiler API against the files at the start commit.

### What S1 decided inside that frame

These were open to the S1 executor. Each is a two-way door.

- **The registries are a package, `integrations/registry`.** Core may import
  an integration only through it, and that is a rule the boundaries gate can
  state because the registry is its own tier. Two generated files, because
  they end up in different bundles: `manifests.generated.ts` behind the root
  entry is plain data, read by the dashboard in a browser and by the Workflow
  DevKit inside the flow bundle; `runtimes.generated.ts` behind
  `@integrations/registry/worker` carries provider SDKs and Node modules and
  is server only. A rule in `tiers.json` refuses an import that crosses
  between them, because that failure appears only in a Vercel build.
- **No dashboard registry yet.** The manifest and runtime shapes were frozen
  in S0; a dashboard entry has no type at all, and decision 18 leaves its host
  UI and its page shape to S7. Generating one now would either invent a
  contract S0 did not freeze or ship a `Record<string, unknown>` S7 would have
  to break. The manifest registry already carries each page's id and label,
  which is what a card and a sidebar read; only the React module needs a third
  registry, and it arrives with the types that describe it.
- **The manifest registry is an array in id order, and the worker registry a
  lookup by id.** The array is the honest generated artifact: its order is
  stable and its diff is reviewable. The indexes by id, by block type and by
  capability are hand-written derivations in `index.ts` and `worker.ts`, where
  they can be documented, and none of them names an id.
- **Entries are imported by relative path, as the block catalog imports block
  manifests.** `gen:integrations` stays a pure file write, with no dependency
  to add to the registry's `package.json` and no lockfile change, so adding an
  integration is a folder and one command.
- **The fixture flag is `INTEGRATION_FIXTURES`, read at generation time.** The
  committed registry is the one generated without it, so a production build
  carries no import of `integrations/_fixtures` at all; CI and demo regenerate
  with it. A runtime branch would bundle the fixture as dead code, and a
  package export condition would ask Nitro, Next and the DevKit bundler to
  agree on a custom resolve condition. `gen:integrations --check` runs in CI
  without the flag, so a fixture that reached the committed registry fails
  there.
- **A directory under `integrations/` without a manifest is refused, not
  skipped**, apart from `sdk` and `registry`, which the generator names. A
  half-written integration that quietly disappears from the registry is the
  failure this stage exists to prevent. A directory whose name starts with `_`
  is never registered: that is how `_template` stays out of every build, and
  `_fixtures/*` waits for its flag.
- **The generator reads manifests with the TypeScript parser rather than
  importing them**, so a build step never executes integration code, and it
  walks the whole reachable graph of a manifest: a manifest may import
  `@integrations/sdk` and files inside its own package, and each of those obeys
  the same rule. A Node module hidden one file away would fail only the Vercel
  build.
- **The core-reference gate is its own script**, `scripts/gates/core-references.mjs`,
  with `scripts/gates/core-references.json` beside it. Core is
  `apps/worker/src`, the dashboard's `app`, `components` and `lib`, and
  `packages`; `scripts/` is release and gate tooling, where the Arthur tenant
  repository is not the Arthur provider, and `changelog/` and `docs/` are
  prose. A mention is a case-insensitive substring of the id in the path or in
  the source with comments stripped: `"github"`, `GITHUB_TOKEN` and
  `githubClient` are one coupling written three ways, and a boundary rule that
  caught those while sparing `githubusercontent` is a rule nobody could
  predict. Comments are prose, so they do not count. Test files are not
  scanned: a test cannot create production coupling, it exercises core code
  that still names a provider, and it changes with its subject in S8 to S12;
  listing several hundred of them would churn on every test edit and get the
  gate switched off. A row may carry `incidental: true` when its files spell an
  id by accident, such as a CSS keyword or a URL; the gate keeps it listed and
  never reports it as stale, because such a hit comes and goes with ordinary
  edits and a failure on one could not be acted on.
- **Allowlist rows carry no counts, and a stale row fails.** The gate's job is
  to stop a new file, a new package or a new area of core learning a provider,
  and to make S8 to S12 shrink the list. A count per file would turn every
  unrelated edit inside a file those stages delete anyway into a failure whose
  fix is a meaningless number. The ratchet is the other way: a row whose file
  stopped naming its provider fails until `--prune` removes it. Nothing adds a
  row but a person with a reason, because a mode that adds rows is a mode that
  switches the gate off.
- **The watched ids are the registry's, asked of the generator through
  `--print-ids`, plus a `plannedIntegrations` table** naming the stage that
  takes each name away. An id in both fails, so the stage that lands an
  integration has to delete its planned entry and its rows.
- **Conformance runs from the registry package**, discovering packages rather
  than listing them, so the template, the fixtures and every integration a
  later stage adds are covered the day they land, whatever the fixture flag
  says. It runs under zod 3 and under the `zod4` alias; the second pass earns
  its place, a one-argument `z.record` in a block's params schema passes the
  first and fails the second.

### The conformance check

`checkIntegrationConformance(manifest, runtime)` returns every issue with a
code, a path and a sentence. It refuses: a manifest that does not parse; an
invalid or reserved id; a block type that is not `<id>_<snake_case>`;
duplicate block types, field keys, environment variables, health check ids or
page ids; a block without a zod params schema; a one-argument `z.record`
anywhere in a params schema (visible only under zod 4, which is why the suite
also runs there); a declared block without an executor; no connection test; no
health check, or one without a probe; an environment variable name that is not
`UPPER_SNAKE_CASE` or is one core reads for itself
(`RESERVED_ENVIRONMENT_VARIABLES`, which is why a field on `DATABASE_URL`
cannot read Connected from core's own database credentials; S1 asserts the
list stays equal to the core-owned names in
`apps/worker/src/infra/runtime-env.ts`, and the provider variables that move
out in S8 to S12 are deliberately absent from it); a field whose key or
variable names a credential (token, secret, password, passphrase, credential,
DSN, private key, API key, signing key, connection string) without
`secret: true`; a secret with a default; a default that fails its
format; an unknown or reserved capability, declared or required; a declared
capability without an adapter; an implementation for something the manifest
does not declare; and a reserved runtime slot that is filled.

## Consequences

- An integration author reads `integrations/sdk` alone: `index.ts` says what
  the three entries are, the types say what to write, and a mistake is a type
  error or a conformance issue that names the rule.
- Core behaviour did not change in S0: the ports moved, and
  `apps/worker/src/adapters/{issue-tracker,vcs,messaging}/types.ts` re-export
  every name.
- `verify:changed` plans a change under `integrations/` as its own scope: the
  root typecheck, the package suites under zod 3 and zod 4, the worker's seam
  tests, `gen:integrations --check` and the gates.
- Harder: every later change to the SDK is additive and recorded below; a
  reserved slot is filled only by the stage named for it.
- Everything S0 left to S1 is done: the lint, package-contracts and knip
  scopes now cover `integrations/`; the generator refuses an integration block
  type a core block already owns; the boundaries gate labels a package tier
  with the root it came from; `packages/AGENTS.md` names both roots;
  `integrations/registry/reserved-env.test.ts` holds
  `RESERVED_ENVIRONMENT_VARIABLES` equal to what the worker declares for
  itself.

### Debt the moved ports carry

The ports moved without signature changes, so provider-specific leftovers
moved with them. Each is removed by the stage that moves its provider.

| Leftover | Where | Owner |
|---|---|---|
| `searchTicketSummaries(jql, ...)` takes a JQL string; `searchTickets(query)` is JQL in practice | `issue-tracker.ts` | S12 |
| `IssueTrackerTransitionTarget.transitionId` is a Jira transition | `issue-tracker.ts` | S12 |
| `downloadAttachment` returns a Node `Buffer`, a Node type in a browser-safe package | `issue-tracker.ts` | S12 |
| `PullRequestHead.headPipeline*` are GitLab's, `latestCheckRuns` and `LatestCheckRun.appSlug` GitHub's; `getLatestCheckRuns` is GitHub only | `vcs.ts` | S10, S11 |
| Comments describe GitHub and GitLab ids (`PRRT_` node ids, discussions) | `vcs.ts` | S10, S11 |
| `TicketEvent` comments describe Slack and Jira; the `note` kind names the `send_slack_message` block | `messaging.ts` | S9 |
| `TicketEvent.pr_ready` carries `RunPullRequest`, whose `provider` is `github | gitlab` in `@shared/contracts`, so a third VCS cannot be reported yet | `messaging.ts` | S10 (decision 19) |
| `GateStatusRef` names GitHub and GitLab, which is why the gate status extensions have not moved | worker `vcs/types.ts` | S10, S11 |
| `GITHUB_APP_PRIVATE_KEY` is base64 in the environment (`adapters/vcs/github-auth.ts:20-21`) while `multiline` invites a raw PEM in the dashboard, and the integration cannot tell the two apart. Proposal: a `pem` format core normalises, so both forms reach the integration the same way | `manifest.ts` | S11 |

## Options considered

**Mirror the worker's internals in the context** (hand integrations the
logger, the `env` object, the settings readers). It would have made the moves
in S8 to S12 a find-and-replace, and it would have made every future worker
refactor a breaking change to every integration, including those in
customers' forks.

**Typed capability access through a registry lookup** (`ctx.capabilities.get("messaging")`)
instead of declaring requirements. Smaller types, but a block could use a
capability the editor never checked, which is the "fails at run time instead
of in the palette" failure decision 13 exists to prevent.

**Define the webhook contract now from `TriggerEvent`.** It is the only
normalized event that exists, and it covers pull requests only; a contract
cut from it would be cut to fit VCS, and S9 would rewrite it.

**Accept `unknown` for reserved slots.** It would compile any object, so a
premature memory adapter would appear to work until S13 designs the port
differently.

## Appendix A: inventory of what the providers use from the worker

A read-only sweep of `main` at `31d8643d` (sweep agents, spot-checked by the
executor). Every item maps to a context member, to an integration's own
dependency, or to a stated reason it stays in core. "Own" means the
integration package declares the dependency itself; an integration's
`worker` entry may use Node and provider SDKs.

### Jira

| Uses today | file:line | Maps to |
|---|---|---|
| Global `fetch` with `AbortSignal.timeout` | `adapters/issue-tracker/jira.ts:100,122,446,457,515` | `ctx.http.fetch` (timeout, retry) and `ctx.signal` |
| Only its port types; no other worker import | `jira.ts:1-10` | the SDK's `issue-tracker.ts` |
| `JIRA_BASE_URL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` passed to the adapter | `engine/support/adapters.ts:83-87` | connection fields (`url`, `secret`, text) |
| `JIRA_WEBHOOK_SECRET` | `services/settings/integration-settings.ts:52` | secret connection field, read by the webhook handler (S9 slot, S12) |
| `JIRA_BACKLOG_TRANSITION_ID` and the board columns | `integration-settings.ts:31-37` | stays in core as `issue_tracker` capability settings (decision 9, S12) |
| HMAC signature check with `node:crypto` | `services/triggers/jira/handle-jira-webhook.ts:1,633-638` | the integration's own webhook handler (S9 slot); Node is allowed in `worker` |
| Dispatch, run lifecycle, clarification resume, run registry reads | `handle-jira-webhook.ts:4-24` | stays in core: a handler returns normalized events and core dispatches (decision 8) |
| Logger | `handle-jira-webhook.ts:8` | `ctx.log` |
| Health: base URL, token, project, webhook secret | `services/system/probes.ts:69-72` | declared health checks with probes |
| Jira research: JQL search scoped to `JIRA_PROJECT_KEY` | `engine/blocks/investigate/execute.ts:423-433` | a block requiring `issue_tracker` or a Jira block (S12), `ctx.connection` |

### Slack

| Uses today | file:line | Maps to |
|---|---|---|
| `chat`, `@chat-adapter/slack` | `adapters/messaging/chatsdk.ts:1-3` | own dependencies |
| Logger | `chatsdk.ts:4` | `ctx.log` |
| `ThreadStore`, the per-ticket parent message id in the database | `chatsdk.ts:7`, `engine/support/adapters.ts:79` | stays in core for now; an integration gets no database. S9 adds it additively, either as core-owned storage handed to the `messaging` factory or as a per-integration key-value store in the context |
| `JIRA_BASE_URL`, to link a ticket from a Slack message | `engine/support/adapters.ts:78` | stays in core; a cross-integration value. S9 passes a ticket link resolved through `issue_tracker` or adds one to `TicketEvent` (a port change S9 owns) |
| `CHAT_SDK_SLACK_TOKEN`, `CHAT_SDK_BOT_NAME` (default `ai-workflow`) | `adapters.ts:73-77`, `infra/runtime-env.ts:48-50` | connection fields (`secret`; `default`) |
| `CHAT_SDK_CHANNEL_ID` | `adapters.ts:76` | a connection field until S9; decision 9 classes a channel choice as operator behaviour, so S9 moves it to stored settings, which then needs a settings read in the context (additive) or a channel parameter on the port |
| Global `fetch` for search | `adapters/messaging/slack-search.ts:220` | `ctx.http.fetch` |
| `SLACK_SIGNING_SECRET`; HMAC check with `node:crypto` | `integration-settings.ts:87`, `services/slack/verify.ts:1,31-39` | secret connection field; own webhook handler (S9 slot) |
| `SLACK_ALLOWED_USER_IDS` | `integration-settings.ts:95-97` | stays in core as a stored setting: who may use a slash command is operator behaviour (S9) |
| `waitUntil` to answer within Slack's deadline | `services/slack/handle-slash-command.ts:10,165` | stays in core: the generic route owns the request lifecycle (S9) |
| Run cancel, dispatch, settings snapshot | `handle-slash-command.ts:12-35` | stays in core (decision 8) |
| Synthesis with `generateStructured` and `resolveCallLlmTarget` | `investigate/execute.ts:8,298,477,532` | `ctx.llm.generateObject` (block requires `llm`) |
| Health: token, channel, signing secret, allowed users | `services/system/probes.ts:103-106` | declared health checks |

### GitHub

| Uses today | file:line | Maps to |
|---|---|---|
| `FatalError` from `workflow` | `adapters/vcs/github.ts:1,504` | the SDK's `FatalError` |
| Logger | `github.ts:4` | `ctx.log` |
| `@octokit/rest`, `@octokit/auth-app` | `adapters/vcs/github-auth.ts:1-2` | own dependencies; Octokit's `request.fetch` takes `ctx.http.fetch` |
| Review ledger markers and bot identity helpers | `github.ts:38-50`, `adapters/vcs/vcs-bot-identity.ts` | stays in core until S11; the marker family core reads is part of the `vcs` contract, so S10/S11 move the pure helpers into the SDK additively |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` (integers), `GITHUB_APP_PRIVATE_KEY` (base64 PEM) | `infra/runtime-env.ts:34-36`, `infra/vcs-config.ts:32-46` | connection fields (`integer`; `secret`) |
| `GITHUB_OWNER`, `GITHUB_REPO` (legacy default repository) | `vcs-config.ts:49-51` | S11 decides: a legacy default repository is configuration, not a credential |
| `GITHUB_BOT_LOGIN`, falling back to `VCS_BOT_LOGIN` in a single-provider deployment | `vcs-config.ts:68-77`, `vcs-bot-identity.ts:11-23` | optional connection field; the fallback stays in core (no aliases, see above) |
| `GITHUB_WEBHOOK_SECRET` | `integration-settings.ts:56-64` | secret connection field |
| Webhook to a normalized `TriggerEvent` | `services/triggers/github/handle-github-webhook.ts` | the `webhook` slot (S9 designs, S11 moves) |
| Repository listing and profile source | `adapters/vcs/repository-directory.ts:2`, `github/profile-source.ts:14` | S10/S11 add them to the `vcs` capability additively |
| Skills loaded from GitHub for harness profiles | `harness-profiles/github-skills.ts` | stays in core: the harness profile owns skills (ADR-006); S11 decides whether a `vcs` method provides the archive |
| Health: App installation and webhook secret | `services/system/probes.ts:73-76,156` | declared health check |

### GitLab

| Uses today | file:line | Maps to |
|---|---|---|
| `FatalError` from `workflow` | `adapters/vcs/gitlab.ts:3,266,369,544,548,737` | the SDK's `FatalError` (the `instanceof` at `:548` becomes a check on the SDK's class) |
| `node:crypto`, `@gitbeaker/rest` | `gitlab.ts:1-2` | own dependencies (Node is allowed in `worker`) |
| `clampBothEnds` from `@shared/workflow-graph` | `gitlab.ts:34` | not importable by an integration (decision 16); S10 copies it or moves it to `@shared/contracts` |
| Logger | `gitlab.ts:35` | `ctx.log` |
| `GITLAB_TOKEN`, `GITLAB_HOST` (default `https://gitlab.com`) | `runtime-env.ts:41-44`, `vcs-config.ts:55-60` | connection fields (`secret`; `url` with `default`) |
| `GITLAB_PROJECT_ID` (legacy default repository) | `vcs-config.ts:60` | S10 decides, as for GitHub |
| `GITLAB_BOT_LOGIN` with the `VCS_BOT_LOGIN` fallback | `vcs-config.ts:75` | as for GitHub |
| `GITLAB_WEBHOOK_SECRET` | `integration-settings.ts:78-81` | secret connection field |
| Profile source | `adapters/vcs/gitlab/profile-source.ts:21-33` | S10, additively |

### Arthur

| Uses today | file:line | Maps to |
|---|---|---|
| Global `fetch` in the client | `sandbox/arthur-client.ts:86` | `ctx.http.fetch` |
| `GENAI_ENGINE_API_KEY`, `GENAI_ENGINE_TRACE_ENDPOINT` | `runtime-env.ts:82-83`, `arthur-injection-check/execute.ts:17-18` | connection fields (`secret`; `url`) |
| Logger | `arthur-injection-check/execute.ts:34` | `ctx.log` |
| `isRunControlError` to rethrow cancellation | `arthur-injection-check/execute.ts:2,33,144` | not needed: core rethrows run-control errors after the executor settles |
| `detectBlatantInjection`, the local prefilter | `arthur-injection-check/execute.ts:3,80` | S8 decides: copy into the integration, or keep a core prefilter that runs regardless of provider |
| Reads the run's ticket (description and comments) when no content is bound | `arthur-injection-check/execute.ts:67-72` | an input binding from the run's ticket snapshot, not a live port read, so the check scans exactly what the agent receives (S8) |
| The run's Arthur task id, created once and shared across steps | `prepare-workspace/execute.ts:326-333` (`ctx.arthur.taskId`), `agent-sandbox.ts:290` | S8, as part of `agent_tracing`'s per-run setup. It cannot be re-derived: `ensureTaskForTicket` creates `<identifier>.<n+1>` once any task for the ticket exists (`sandbox/arthur-client.ts:152-163`), which is why the run caches the id. So S8 designs per-run integration state that the workflow carries, serializable and additive to this contract |
| Tracer files, environment, `pip install` and hooks in the sandbox | `sandbox/agents/claude.ts:510-558`, `codex.ts:95-101`, `sandbox/arthur-tracer.ts` | `agent_tracing`, designed in S8 |
| Evals collection and route, `evaluationTraceSettings` | `services/overview/collect-eval-summary.ts:11,24`, `routes/api/v1/evals.get.ts` | the `api` slot (S8) and a page |
| Health probe of the API | `services/system/probes.ts:107-108,249-256` | a declared health check |

### What the inventory proves

No provider needs a database handle, the process environment or a worker
module that the context does not replace. What remains in core is dispatch
and run lifecycle (decision 8), operator settings (decision 9), request
lifecycle of webhooks (S9), per-run state tied to tracing (S8), and one
cross-integration value (the tracker's ticket link in Slack messages, S9).
Two needs are real and not yet in the context, each named with its stage:
durable per-ticket thread state for messaging (S9) and reading an
integration's stored settings (S9, when the Slack channel moves).

## Change log

Additive changes to `@integrations/sdk` after S0, newest first. Each entry
names the stage, what was added, and why the context or a port needed it.

| Date | Stage | Change | Reason |
|---|---|---|---|
| 2026-09-18 | S1 | `ErasedIntegrationRuntime` and `ErasedIntegrationCall` | The generated registry has to hold runtimes whose types come from manifests core does not know statically. `IntegrationRuntime<IntegrationManifest>` is not that type: a block executor typed against a literal block type is not assignable to one typed against `IntegrationBlockManifest`, because its parameters are contravariant, and the compiler says so. The erased interface keeps the keys and the results and erases only the parameters, so core can list an integration's blocks, health checks and capabilities and use what each call returns, and S4 narrows the call once where it builds the context. |
| 2026-09-18 | S0 | Contract created | This record |
