Status: current
Last-verified: 2026-09-23

# Writing an integration

This page is for someone who has never seen this repository and wants their
own service on the Integrations page and usable in a workflow. It assumes you
know your provider's API and nothing about our engine. With this page, the
template (`integrations/_template`) and the SDK (`integrations/sdk`) open, you
should not need anything else. Where you do, that is a gap in this page:
say so in your pull request.

The five integrations that ship (`integrations/arthur`, `slack`, `gitlab`,
`github`, `jira`) and the built-in memory provider
(`apps/worker/src/memory/builtin/adapter.ts`) are the worked examples. Each one
solved a different problem, and this page points at the one that solved yours.
[ADR-010](../adr/ADR-010-integrations.md) holds the reasons behind every rule
here, stage by stage.

## Before you write a line: read the current documentation

Your adapter is only as right as the page you wrote it against, and a fixture
is only as true as the page it was recorded from. Read your provider's
current API reference before you start, and again whenever you are about to
write a header name, a status code or a field you have not read today:

- how it authenticates, and what it answers to a wrong credential;
- every call you will make: its path, its parameters, and exactly what it
  returns, including whether a write is done when it answers or only
  accepted for later;
- its webhooks: which events exist, what a payload looks like, what is
  signed, how, and in which header;
- its rate limits, what it answers when you hit one, and whether it sends
  `Retry-After`;
- its error codes, and which of them mean "your credential is wrong" rather
  than "try again".

An agent does this with the `ctx7` CLI: `ctx7 library <provider> "<question>"`
finds the library id, then `ctx7 docs <id> "<question>"` answers from current
documentation, one question per concept. When `ctx7` has no entry, read the
provider's published reference directly. Either way, write down what you read
and when: the template's README has a table for it, and every recorded
payload carries its source (see "Recorded payloads").

What skipping this costs: an adapter written from memory passes every test
you wrote from the same memory, and fails its first real call. A fixture
copied from a page that changed since proves the old behaviour. Providers do
move: on 2026-09-22 Mem0's documentation carried a migration from its v2 to
its v3 platform API, and it answers an add with `PENDING` and an event id to
poll, not with the stored memory.

The same holds for our own stack. Before you rely on how the Workflow DevKit,
zod (both majors, see "zod 3 in tests, zod 4 in production"), Next.js or your
test runner behaves, read the version this repository pins.

## From nothing to a connected integration

The whole path, so you can see where each section below fits. Commands run
from the repository root.

1. **Pick an id.** 3 to 32 lowercase letters and digits, starting with a
   letter: `hippo`, not `Hippo`, `hippo-ai` or `hippo_ai`. It names the package
   (`@integrations/<id>`), the webhook URL (`/webhooks/<id>`), the screen
   (`/integrations/<id>`) and the prefix of every block type, and it is
   written into stored rows, so it is permanent once shipped (see "Things you
   may not do").
2. **Create the package.** `pnpm run new:integration -- <id> --name "Display Name"`
   copies `integrations/_template` to `integrations/<id>` with the template's
   names replaced, a `test` script and a first test included. It refuses,
   before writing anything, an id the SDK reserves, one an integration
   already has, and one that core source already spells where no allowlist
   row covers it, because the core-reference gate would fail your first run
   on every such file. What the gate reads as core, and what it counts as
   spelling an id, in the words it prints with every failure and the
   scaffold with every refusal:

   > Core is apps/worker, apps/dashboard, packages, as git lists them, minus
   > every path matching an `exclude` pattern in
   > scripts/gates/core-references.json.
   >
   > Core spells a provider id where one word starts with it, or where
   > consecutive words join to exactly the id, in any case, in a file's path
   > or in one identifier, string, template, regular expression or piece of
   > JSX text; words split at punctuation and at case changes, so
   > GITHUB_TOKEN, githubClient, GitHub, jira-client and mem0ai each spell
   > their id, while scriptsEntry does not spell sentry and Team settings
   > does not spell teams. Comments and the text of a className or style
   > attribute are not read.

   The refusal names the files. Where one is not about your provider (sample
   data, a URL on a host that merely starts with the word), add the id to an
   allowlist row with the reason and run the scaffold again; otherwise pick
   another id. `acme` appears in core's examples, so it is refused.
3. **Install and register it.** `pnpm install` links the new workspace package
   and adds it to the lockfile; `pnpm run gen:integrations` adds it to the
   generated registries in `integrations/registry`. From here the worker, the
   dashboard and the Workflow DevKit know it exists.
4. **Record its connection shape.**
   `pnpm --dir apps/worker exec vitest run src/services/integrations/connection-shape.test.ts -u`
   writes your fields into `connection-shape.snapshot.json`. That test fails
   whenever a shipped integration's connection fields change (see "What the
   run pin does to you"); for a new integration the change is only the
   addition.
5. **Check it.** `pnpm --filter @integrations/<id> run typecheck` and
   `pnpm --filter @integrations/registry run test` (the conformance suite).
   Both pass before you have edited anything. From here on, run them after
   every change.
6. **Make it yours:** the manifest, then the worker, then the tests, using
   the sections below. Delete what you do not need: the block, the page, or
   both.
7. **Prove it on a deployment** you are allowed to change (see "Testing
   without our production credentials").
8. **Open the pull request** with the checklist at the end of this page.

What a person sees once it is deployed: the Integrations page lists a card
for it, Not connected, with its description, its docs link and what it
unlocks. On a deployment whose environment sets every required variable, it
reads Connected (environment) with nothing to click. Otherwise an admin opens
the card's Connection tab (`/integrations/<id>/connection`), fills the fields
your manifest declares and saves; saving runs your connection test first and
activates the values only if it passes. Once connected and enabled, its
blocks appear in the editor's palette under its name, its pages appear in the
sidebar below the Integrations separator, its checks appear on the System
health page, and `system.capabilities` over MCP lists it with its blocks.

## What an integration is

One package under `integrations/<id>` with up to three entry points, because
three different bundles read it and each tolerates different code:

| Entry | Holds | Read by | May import |
|---|---|---|---|
| `manifest.ts` | Plain data: identity, connection fields, capabilities, blocks, pages, health checks | The dashboard in a browser, the worker, and the Workflow DevKit's flow bundle | `@integrations/sdk` and files inside the package, nothing else |
| `worker.ts` | The code: connection test, capability adapters, block executors, health probes, webhook handler, page readers | Worker steps and routes only | Anything the package declares, Node included |
| `dashboard.tsx` | One React component per page the manifest declares | The dashboard | `@integrations/host-ui` and files inside the package |

It is compiled into every build of the product. There is no runtime loading
and no install from a registry: a deployment decides only whether it is
connected and enabled. A fork adds its own integrations the same way.

The package also carries a `README.md` (the generator refuses a package
without one), a `package.json` named `@integrations/<id>` with a `typecheck`
script (without it the package silently drops out of `pnpm -r typecheck`), and
a strict `tsconfig.json`. Relative imports carry no extension (`./manifest`,
never `./manifest.js`): Nitro tolerates the second form and the dashboard's
webpack build does not.

### What it is handed, and what it can reach

Core hands your code an `IntegrationContext` (`integrations/sdk/context.ts`)
and nothing else: your resolved connection values, an HTTP client, a logger,
a deadline, and while a block runs, the run's identity, the capabilities the
block declared and a model. A dashboard page is handed `{ integrationId,
data }`. There is no session, no database handle and no client of the worker
in any of it.

That is a statement about what is **handed**, not about what is **reachable**.
Your worker code runs in the worker's process and your pages run in the
dashboard's, as Server Components. Nothing is sandboxed: global `fetch`,
`process.env` and any dependency your package declares are there without an
import from us. The registry generator refuses some of them in what you write
(Node's globals in a manifest's files, `process` in a page's, see below), but
that is a check on your source, not a sandbox. Integration code is trusted build-time code that we review
like our own, and the rules on this page exist so that it does not couple
itself to our runtime by accident, not to stop code that means harm.

So the rules are about consequences. Reading `process.env` in `worker.ts`, for
example, is not refused by any gate, and it is still wrong: the value
bypasses the connection source an admin chose, is not pinned to a run, is not
redacted from logs, and does not exist on a deployment that connected you
from the dashboard. Everything your code needs from an operator goes through
a connection field.

## Capabilities

A capability is a seam in core that an integration can fill: core does the
work (a run notification, a pull request, reading memory into a prompt) and
asks whichever integration serves the capability to talk to the provider.
Declare the ones you serve in `manifest.capabilities`, and give each an
adapter factory under `capabilities` in `worker.ts`. The factory receives your
context and returns the port's adapter.

| Capability | Port (in `integrations/sdk`) | Providers at once | Served today by | Read first |
|---|---|---|---|---|
| `issue_tracker` | `IssueTrackerAdapter` (`issue-tracker.ts`), plus `issueTrackerQueryRule` on the runtime | one | Jira | `integrations/jira`: the tracker a deployment runs its board on. The board's columns are settings of the capability, not connection fields, so the next tracker reads the same ones. `jql.ts` is its rule for a query an author typed. |
| `vcs` | `VCSAdapter` (`vcs.ts`), plus the optional surfaces in `vcs-extensions.ts` | many, chosen per repository | GitHub, GitLab | `integrations/gitlab`: a provider chosen per repository, self-hosted, with nested paths. `integrations/github`: a credential that is not a token (an App id, an installation id and a private key, read in `auth.ts`). A `vcs` manifest also declares `repositories` (host, whether paths nest, and in `changeRequest` what a person calls a change request and how one is referenced) and the connection field for its automation account's login (below). |
| `messaging` | `MessagingAdapter` (`messaging.ts`) | one | Slack | `integrations/slack`: one active provider, run notifications in one thread per ticket, a slash command. |
| `memory` | `MemoryAdapter` (`memory.ts`) | one | built-in, in core | `apps/worker/src/memory/builtin/adapter.ts`, and "Memory" below. |
| `agent_tracing` | `AgentTracingAdapter` (`agent-tracing.ts`) | many | Arthur | `integrations/arthur`: a description of files, packages, environment and hooks that core applies to every agent sandbox. `otelFixtureRuntime` in `integrations/sdk/fixture-runtime.ts` is a second, minimal provider. |
| `agent_tools` | reserved | many | nobody | Declaring it is a type error and a conformance failure until a later plan designs it. |

**"One" means one active provider per deployment.** When two connected,
enabled integrations serve the same `one` capability, core refuses to guess:
every use answers with a sentence naming both, and nothing is sent, read or
written through either. There is no control to choose between them yet; an
admin disables the one they do not want.

**A tracker also says how it reads a query an author typed.** The investigate
block's query template is written in the tracker's own language, so a runtime
that serves `issue_tracker` carries `issueTrackerQueryRule: { problem(query) }`
(`IssueTrackerQueryRule`), required by the type and by conformance: why the
tracker would not run the query, in a sentence for the author, or `null`.
Your adapter's `findTickets` must use a `providerQuery` exactly when this
finds no problem with it, so the two cannot disagree (Jira's `findTickets`
calls the same function). A tracker with no query language says so here
rather than accepting a query it would ignore. Core asks it without a
connection, and only while exactly one tracker is connected, in two places:

- **When a definition is saved or deployed**, it refuses a template the rule
  refuses, unless the deployed version already runs that same template. That
  one the editor shows as a notice, which never blocks Deploy, and rolling
  back, restoring or enabling a version does not ask at all: a rule newer
  than a stored template never takes away what runs today
  (`apps/worker/src/services/workflow-definitions/tracker-query-templates.ts`).
- **When the investigate block runs**, before it searches. A template the
  rule refuses is left out, the search narrows by the ticket's keywords alone
  (or does not run when there are none), and the block's theory says so in a
  sentence, with a warning in the log.

**A block uses a capability by requiring it**, not by serving it. List it in
the block's `requires.capabilities` and the editor offers the block only
while some integration serves it; the executor's `ctx.capabilities` then has
exactly those keys (`integrations/_fixtures/demo/worker.ts` requires
`messaging`). `memory` and `agent_tracing` have no key there: core applies
them around a run, and a block may name them only to be offered or not.

**Ports speak the product's language, never a provider's.** When your port
needs a fact core does not give you, the fix is a new provider-neutral field
in the SDK, added and recorded in ADR-010's change log, not your provider's
word in a shared type. S11 is the example: core read GitLab's word for a push
(`action === "update"`), so every other provider's push went unchecked, and
the fix was a flag that states the fact (`headMoved` in
`integrations/sdk/webhook.ts`). The leftovers that still name a provider are
listed in ADR-010, "Debt the moved ports carry", with who removes each.

**A `vcs` provider may serve more than the port.** Publishing a gate status
(and its details), listing a pull request's changed files, publishing a
review, and reading a pull request for a manual dispatch are optional
surfaces, each an interface in `integrations/sdk/vcs-extensions.ts` with a
guard beside it (`hasPRFilesCapability` and the rest). Implement the ones your
provider can; a run that needs one its provider lacks stops with an error
saying so. Core asks the adapter it resolved for the repository, because the
deferred adapter it hands out before the connection resolves forwards the
port's members only. Three more things are the contract, not your choice:

- **Every marker the workflow writes into a pull request** (the bot marker,
  the review ledger's replies and failure notes, the review round's summary,
  head and finding markers) is built and read by
  `integrations/sdk/review-markers.ts`. Use those functions rather than a
  string of your own: a marker already posted on somebody's pull request must
  keep reading, and `review-markers.test.ts` holds the literals it must.
- **The automation account's login** is a non-secret connection field keyed
  `VCS_BOT_LOGIN_FIELD` (`botLogin`), which conformance requires of a `vcs`
  manifest (`vcs_bot_login_missing`). Your webhook reads it to leave the
  workflow's own activity out (compare with `vcsLoginsMatch`), and core
  filters again against the account it resolves.
- **A head read fails one way.** `getPRHead` and `getPRHeadSha` throw
  `PullRequestUnreadableError` exactly when `isPullRequestRefusal` says this
  connection can never read that pull request, and throw anything else as it
  came, with the provider's answer where the client keeps it.

### Memory

Memory is the one capability core serves by itself. A deployment that
connects nothing uses the built-in store, which is a core module rather than
a package because it needs core's database. Connecting a memory integration
**replaces** that store; disabling the integration returns the deployment to
the built-in store, which was not touched in between. Two things never fall
back to the built-in store, because either would split a deployment's memory
across two stores with nobody told: settings that cannot be read, and a
memory integration that is enabled but Failing (a refused key, say). Runs
then go on without memory and say which provider failed. Two enabled memory
integrations are refused the same way until an admin disables all but one.

The port (`integrations/sdk/memory.ts`) was designed against the built-in
store and the published APIs of Mem0 and Zep. Read its comments whole; the
rules that bite:

- **Observations in, rendering out.** Core says what a run learned about a
  subject (`observe`) and asks what is known (`recall`). Your engine decides
  what to keep, merge and forget, and renders what it knows in `rendering`,
  which core puts into a prompt as is.
- **`recall` and `observe` never throw.** A failure is an answer
  (`{ ok: false, code, detail }`), because memory must not be able to change
  a run's outcome. A throw is caught by core and recorded as `unavailable`,
  but that is a bug in your adapter, not a contract.
- **Your failure codes are three**: `unavailable` (could not be reached, worth
  retrying), `contended`, `rejected` (retrying will not help). The other four
  are core's.
- **`stored` is acceptance, not read-after-write.** An engine that accepts a
  write and merges it later answers `stored: true`. `removed`, `dropped` and
  `remaining` are only logged, and only when one of the first two is above
  zero, so an engine that cannot know them yet answers zeros.
- **`onlyIfEmpty` is yours to honour**: a deterministic seed may create a
  subject's memory and never edit what a run wrote. Check `held` first.
- **`subject.key` is an address, not text.** Store it and compare it; never
  parse or rewrite it, or everything already stored is orphaned.
- **`store` is optional** and has the opposite rule: its three methods may
  throw. An engine that cannot list what it holds leaves it out, and the
  memory screen says so instead of showing an empty list.

This is the shape, compiled and checked with everything else on this page:

```ts file=memory.ts
import {
  z,
  type IntegrationContext,
  type MemoryAdapter,
  type MemoryFailure,
  type MemoryRecall,
  type MemoryScope,
  type MemoryWrite,
} from "@integrations/sdk";
import type { manifest } from "./manifest";

type Context = IntegrationContext<typeof manifest>;

const searchAnswer = z.object({ memories: z.array(z.object({ text: z.string() })) });

/** Core's scope, in the one string this engine files it under. Never parsed back. */
function scopeName(scope: MemoryScope): string {
  return scope.kind === "notebook" ? `notebook/${scope.name}` : scope.kind;
}

/** A status the engine answered with, as the port's word for it. */
function failureOf(status: number): MemoryFailure {
  const retryable = status === 408 || status === 429 || status >= 500;
  return retryable ? "unavailable" : "rejected";
}

function described(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hippoMemory(ctx: Context): MemoryAdapter {
  const headers = {
    authorization: `Bearer ${ctx.connection.apiKey}`,
    "content-type": "application/json",
  };

  async function recall(request: Parameters<MemoryAdapter["recall"]>[0]): Promise<MemoryRecall> {
    try {
      const url = new URL(`/v1/projects/${ctx.connection.projectId}/search`, ctx.connection.baseUrl);
      url.searchParams.set("subject", request.subject.key);
      url.searchParams.set("scope", scopeName(request.scope));
      const response = await ctx.http.fetch(url, { headers });
      if (!response.ok) {
        return { ok: false, code: failureOf(response.status), detail: `Hippo answered ${response.status}` };
      }
      const answer = searchAnswer.safeParse(await response.json().catch(() => null));
      if (!answer.success) {
        return { ok: false, code: "unavailable", detail: "Hippo answered in a shape this integration does not read" };
      }
      const excluded = new Set(request.exclude ?? []);
      const entries = answer.data.memories
        .filter((memory) => !excluded.has(memory.text))
        .map((memory) => ({ text: memory.text }));
      return {
        ok: true,
        held: answer.data.memories.length > 0,
        entries,
        rendering: entries.map((entry) => `- ${entry.text}`).join("\n"),
      };
    } catch (error) {
      return { ok: false, code: "unavailable", detail: described(error) };
    }
  }

  return {
    recall,
    async observe(request): Promise<MemoryWrite> {
      try {
        const { observation } = request;
        if (observation.kind === "items" && observation.onlyIfEmpty) {
          // A seed may create a subject's memory and never edit one a run wrote.
          const current = await recall({ subject: request.subject, scope: request.scope });
          if (!current.ok) return current;
          if (current.held) return { ok: true, stored: false, removed: 0, dropped: 0, remaining: 0 };
        }
        const url = new URL(`/v1/projects/${ctx.connection.projectId}/memories`, ctx.connection.baseUrl);
        const response = await ctx.http.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({
            subject: request.subject.key,
            scope: scopeName(request.scope),
            run: request.runId,
            observation,
          }),
        });
        if (!response.ok) {
          return { ok: false, code: failureOf(response.status), detail: `Hippo answered ${response.status}` };
        }
        // Hippo answers 202 and merges later: `stored` means it took the
        // observation, never that the next recall returns it. The three counts
        // are what the engine knows at this moment, which for an engine that
        // merges later is nothing.
        return { ok: true, stored: true, removed: 0, dropped: 0, remaining: 0 };
      } catch (error) {
        return { ok: false, code: "unavailable", detail: described(error) };
      }
    },
  };
}
```

Hippo is invented; its paths and status codes are placeholders for the ones
your engine's documentation gives you. What is not a placeholder is the
shape: every path out of both methods is an answer.

Two facts about how core calls a memory adapter, because they decide how you
write one. Core resolves the provider once per step and may make many calls
through it (reading memory into one prompt is up to `1 + 2N` recalls). Each
request is bounded by its own attempt timeout, and all of them together by a
budget of 60 seconds of time spent waiting on your provider in that step
(`MEMORY_CALL_BUDGET_MS` in `apps/worker/src/engine/support/memory-runtime.ts`).
Time the step spends elsewhere, on a model call between a read and a write,
is not charged. When the budget runs out core aborts `ctx.signal`, the call
in flight and every later one in that step answer `unavailable` at once, and
your adapter must turn an aborted request into `unavailable` too, never a
throw. And a run is not
yet held to the memory provider it started with: the comparison exists and no
call site passes it a pin, so a run in flight when an admin connects you may
read from the built-in store and write to you.

## One connection

An integration has one connection per deployment. The fields your manifest
declares are the whole of what an operator gives you:

```ts file=manifest.ts
import { defineIntegration } from "@integrations/sdk";

export const manifest = defineIntegration({
  id: "hippo",
  name: "Hippo",
  description: "Keeps what each run learned in Hippo, and gives it back to the next run.",
  docsUrl: "https://hippo.example/docs",
  connection: {
    fields: [
      {
        key: "baseUrl",
        label: "API URL",
        description: "Where the Hippo API answers.",
        env: "HIPPO_BASE_URL",
        secret: false,
        format: "url",
        optional: true,
        default: "https://api.hippo.example",
      },
      {
        key: "projectId",
        label: "Project",
        description: "The Hippo project this deployment writes into. It names the account.",
        env: "HIPPO_PROJECT_ID",
        secret: false,
      },
      {
        key: "apiKey",
        label: "API key",
        env: "HIPPO_API_KEY",
        secret: true,
      },
      {
        key: "webhookSecret",
        label: "Webhook secret",
        description: "Only needed if Hippo should call back when it has processed a write.",
        env: "HIPPO_WEBHOOK_SECRET",
        secret: true,
        optional: true,
      },
    ],
  },
  capabilities: ["memory"],
  blocks: [],
  pages: [],
  health: [
    {
      id: "api",
      label: "API access",
      description: "Hippo accepts the API key for the configured project.",
      critical: true,
    },
  ],
});
```

Write the manifest inline, as above, or declare blocks with
`defineIntegrationBlock`. `defineIntegration` keeps every id, block type and
field key as a literal type, which is what types `ctx.connection` and every
executor from the manifest; TypeScript's `const` type parameters infer
literals only for values written in the call. A manifest built from a
variable annotated `: IntegrationBlockManifest`, or a field list assembled
elsewhere, would silently switch those checks off, so the SDK refuses it at
the manifest with a sentence saying what to do.

What each field property does, and what it costs to get wrong:

- **`key`** is the name in `ctx.connection`; **`env`** is the variable that
  carries the value when the environment is the source. Every field names
  one, so a deployment can be configured without touching the dashboard. Use
  `UPPER_SNAKE_CASE`, at least four characters (MCP hides every declared name
  from agents, and cannot hide a shorter one inside ordinary words), and
  never a variable core reads for itself (`RESERVED_ENVIRONMENT_VARIABLES`).
- **`secret: true`** makes a value write-only: it reaches your server code
  and nothing else, never an API response, an MCP result, the browser or a log
  line (your logger and your error messages are redacted against it).
  Conformance refuses a field whose key or variable reads like a credential
  (token, key, secret, password and the like) without it, and a secret with a
  default.
- **`identity: true`** is for a secret that also names the account, so that
  swapping it for another account's stops runs in flight instead of reading
  as a rotation. Slack's bot token is the case: nothing else says which
  workspace it is. It has a cost: rotating that secret also stops runs in
  flight. Prefer a non-secret field that names the account, as `projectId`
  does above and Jira's site URL does, and leave the token unmarked.
- **`optional`** and **`default`**: absent means required. `default` is used
  when the source leaves the field unset; a secret has none.
- **`format`**: `text`, `multiline` (a PEM key), `url`, or `integer`, which
  reaches `ctx.connection` as a number. There is no `pem` format: GitHub reads
  both a raw PEM and its base64 form itself (`integrations/github/auth.ts`)
  because an admin will paste either.

Operator behaviour that is not about reaching the provider (which board
columns a tracker watches, who may run a command) is not a connection field.
It is a stored setting of the capability, like Jira's columns. Slack's
channel is the documented exception, kept as a field because moving it would
have been a data migration.

### Where the values come from

Exactly one source at a time, per integration: the **environment** variables
your fields name, or values an admin **stored** from the dashboard. They never
mix. With nothing stored, the environment is the source when every required
field has its variable set; when some but not all are set, the card reads
Failing and names the missing variables. A manifest whose fields are all
optional never reads Connected on its own. Stored secrets are encrypted under
the deployment's `INTEGRATION_SECRETS_KEY`; without it, stored values are
unavailable and environment values still work.

An admin can prepare and test stored values while the environment is still
the source, and switch in one action. **Disable** is a stored flag that works
for either source and is read at every use: it is the kill switch an admin
reaches for, and your blocks stop with `integration_unavailable.disabled` at
their next use.

**Writes are refused on a deployment that does not own its database.**
Preview deployments, and the demo deployment, read production's database, so
a toggle there would change production. Every write on the Connection tab is
refused there with 403, naming both environments. On such a deployment the
environment is the only lever: set the variables and redeploy.

### The connection test

`testConnection` runs before stored values become the active connection and
whenever an admin presses Test. It answers one question, and the difference
between its two failure paths is the difference between a failed button and
a stopped deployment:

- return `{ ok: false, reason }` **only when the provider said the credential
  is wrong** (a 401, a 403, an unknown project). Core records the connection
  as Failing, and every run that needs it stops until somebody fixes it;
- **throw** for everything else: a timeout, a 5xx, a body that is not your
  provider's. Core records "could not be reached" and leaves a working
  connection as it was.

Arthur's (`integrations/arthur/worker.ts`) throws for a 5xx and refuses a 401
or a 403, but it also refuses every other 4xx, a 429 included, which is a
provider asking you to wait. This one draws the line where it belongs:

```ts file=worker.ts
import { defineIntegrationRuntime, type IntegrationRuntimeDefinition } from "@integrations/sdk";
import { manifest } from "./manifest";
import { hippoMemory } from "./memory";
import { webhook } from "./webhook";

const definition: IntegrationRuntimeDefinition<typeof manifest> = {
  testConnection: async (ctx) => {
    const response = await ctx.http.fetch(
      new URL(`/v1/projects/${ctx.connection.projectId}`, ctx.connection.baseUrl),
      { headers: { authorization: `Bearer ${ctx.connection.apiKey}` }, retries: 0 },
    );
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "Hippo refused the API key for this project." };
    }
    if (response.status === 404) {
      return { ok: false, reason: `Hippo has no project ${ctx.connection.projectId} for this key.` };
    }
    // Nothing here is about the credential. A throw leaves a working
    // connection as it was; a refusal would stop every run that uses it.
    throw new Error(`Hippo answered ${response.status}.`);
  },
  capabilities: {
    memory: hippoMemory,
  },
  blocks: {},
  health: {
    api: async (ctx) => {
      const response = await ctx.http.fetch(
        new URL(`/v1/projects/${ctx.connection.projectId}`, ctx.connection.baseUrl),
        { headers: { authorization: `Bearer ${ctx.connection.apiKey}` }, retries: 0, timeoutMs: 3_000 },
      );
      if (response.ok) return { status: "live" };
      return { status: "down", message: `Hippo answered ${response.status}.` };
    },
  },
  webhook,
};

export const runtime = defineIntegrationRuntime(manifest, definition);
```

Keep the `IntegrationRuntimeDefinition<typeof manifest>` annotation. Written
inline as the second argument of `defineIntegrationRuntime`, the health
probes lose their types: `ctx` becomes an implicit `any` and a returned status
widens to `string`.

### What the context gives you

- **`ctx.connection`**: the resolved values, typed from your fields. A
  connection test receives the values being tested, which may not be the
  active ones yet.
- **`ctx.http.fetch`**: standard `fetch` signature, so it can be handed to a
  provider SDK that accepts a custom fetch. Each attempt has a 30 second
  timeout, and an attempt ends when the whole body has been read: the
  response comes back with its body already read, so a body the provider did
  not finish in time is a failed attempt, never a short success. Pass
  `streamBody: true` with a `timeoutMs` of its own for a download too large
  to hold in memory. A read (GET, HEAD, OPTIONS) is retried twice after a
  network error, a 429 or a 5xx, honouring `Retry-After` up to 30 seconds;
  nothing else is retried unless you pass `retries`, because repeating a
  write after an ambiguous 5xx reports a conflict for work that landed. A
  non-2xx response is returned, not thrown. It is bound to `ctx.signal`, and a `signal` you pass
  in its options is honoured alongside it, across retries and the waits
  between them. A thrown error keeps its `name` (`TimeoutError`,
  `AbortError`) and has this connection's secrets taken out of its message.
- **`ctx.log`**: pino's argument order, fields first, then an event name in
  snake_case: `ctx.log.info({ matches }, "hippo_search_answered")`. Secrets
  are redacted.
- **`ctx.signal`**: the context's lifetime, set by whatever core is doing
  when it calls you. It is not tied to a run being cancelled. Work with a
  deadline of its own gets that deadline: a block has 240 seconds, a
  connection test 20, a page reader 20, a webhook request 120, `beginRun` 60,
  a health probe about 4. A capability adapter core holds for a stretch of
  work (a poll pass, a run's downloads) gets a lifetime that does not abort on
  its own, so each of your requests is bounded by its attempt timeout
  instead; memory is the exception, aborted once your provider has used up
  the time core gives memory in one step (see "Memory"). Pass it to anything
  you wait on that is not `ctx.http`.
- **`ctx.webhookUrl`**: where this deployment receives your deliveries, for a
  health check that compares it with what the provider holds. Absent when
  the deployment does not know its public URL.

A provider SDK is fine as long as it sends through `ctx.http`. GitHub's
Octokit is built with `request: { fetch: ctx.http.fetch }`, which covers the
App's installation token minting as well (`integrations/github/auth.ts`), and
GitLab's Gitbeaker is handed a requester that sends through the same fetch
(`integrations/gitlab/client.ts`), so neither reaches the global `fetch` or
retries on its own; each package's `client.test.ts` runs the real SDK with a
global `fetch` that throws. Arthur, Slack and Jira call `ctx.http` directly.

### What the run pin does to you

A run records, at its start, a fingerprint of each integration's connection
it uses: the values of its non-secret fields, plus a digest of every secret
marked `identity`. At every later use core compares it with the connection in
force:

| What changed | What the run does |
|---|---|
| A secret was rotated | Follows it, so rotation needs no outage |
| An `identity` secret, or any non-secret value | Stops at its next use with `integration_unavailable.reconfigured` |
| The integration was disabled | Stops at its next use with `.disabled` |
| It was disconnected | Stops at its next use with `.disconnected` |
| The same values saved again, or the source switched with identical values | Nothing |

Where the comparison happens today: the blocks your integration contributes,
and the `messaging` and `vcs` capabilities that core blocks consume. The
`issue_tracker` and `memory` capabilities have the comparison written and no
caller passes it a pin yet
(`apps/worker/src/engine/support/issue-tracker-runtime.ts`,
`memory-runtime.ts`), so a run using them follows the connection as it is now.

What it means for the manifest of an integration that has shipped: renaming a
field's key or `env`, changing its `default`, or turning `identity` on or off
moves the fingerprint on every deployment that sets that field, and stops
every run in flight through the integration. That is why the connection shape
is a committed snapshot (`apps/worker/src/services/integrations/connection-shape.snapshot.json`):
the edit and its consequence arrive in the same review, and a pull request
that moves a shipped integration's row says which runs have to be drained
first. Adding a field nobody has set moves nothing.

## Health checks

A health check tells an admin, on the System health page, whether something
your integration depends on works right now, without running a workflow: a
token that still authenticates, a channel the bot can post in, a webhook the
provider still points here. Declare at least one in `manifest.health` and
give each a probe of the same id under `health` in `worker.ts`.

- Core adds a `connection` row to your section and runs your probes only
  while the integration is usable, each bounded at about four seconds, in
  parallel. Ask once; do not retry inside a probe.
- A probe returns `live`, `degraded` or `down` with a message. A throw is a
  `down` row carrying your error's message, redacted and cut to 300
  characters. Anything else, including nothing, is `down` as well: a health
  page must never paint Live over something nobody measured.
- `critical` decides what a failing check does to your section: a critical
  check that is down makes the section Down, a non-critical one makes it
  Degraded. It never changes whether your integration is usable. Only the
  connection decides that, so a failing probe does not stop a single run.
- A check may not be called `connection`, which is core's row.

The connection test and a health check look alike and answer different
questions: the test decides whether values may become the connection; a check
reports, later, on what the connection depends on. Slack's `channel` check
(`integrations/slack/worker.ts`) schedules a message sixty days out and
deletes it, because that is the only way to prove the bot may post in a
channel; Jira's `webhook-registration` is non-critical because a deployment
can run on its poller alone.

## Blocks

An integration block is one step of a workflow that belongs to your
integration: the palette groups it under your name, and it is offered only
while you are connected and enabled. The template's `example_lookup`
(`integrations/_template/manifest.ts`, `worker.ts`) is a complete one.

In the manifest:

- **`type`** is `<id>_<name>` in lowercase words joined by underscores. It is
  stored in every workflow that uses the block.
- **`paramsSchema`** is a zod schema written with the `z` the SDK exports.
  **The editor has no form for an integration block's parameters yet**: a node
  starts with the manifest's `defaults` and an author cannot change them in
  the editor, only through MCP or an imported definition. Take what an author
  must choose as an **input** they bind, and keep parameters to what has a
  sensible default, written both in the schema and in `defaults`.
  Conformance parses `defaults` with `paramsSchema` under both zod majors and
  refuses a default the schema rejects, because a new node starts with it and
  nothing in the editor could fix it. It also refuses a `z.record` keyed by an
  enum or a literal, which zod 3 reads as every key optional and zod 4 as every
  key required: write `z.object` with each key optional instead.
- **`contract.ports`** is exactly `["out"]`. A second port would be offered in
  the editor, refused at publish and propagate to nothing at run time, so the
  generator and conformance both refuse it. Branch on `status` instead.
- **`output.statusVariants`** lists every value `status` can take; stored
  graphs branch on them. **`output.required`** fields are typed from the
  manifest, so an executor cannot forget one.
- **`output.mustRead`** names a field a published graph has to act on: the
  first node on every path out of the block must be a Branch on it. Arthur's
  injection check declares `status`, because a verdict nobody reads lets the
  run carry on whatever it says.
- **`inputs`** are values bound from upstream blocks. An input may declare
  `defaultFromSubject` (`title`, `description`, `comments`) to be filled from
  what the run is about when nothing is bound.
- **`requires`**: the capabilities the block uses, and `llm: true` if it calls
  `ctx.llm`.

In the worker, an executor receives `{ params, inputs }` (params parsed by your
schema, inputs typed from the manifest) and the block context, and returns:

- `{ kind: "next", output }` to continue, `status` included;
- `{ kind: "failed", message, detail? }` for an expected failure: `message` is
  what a person reads on the run and in the ticket comment, `detail` goes to
  the log.

A throw is reported like `failed`, with the error's own message. Either way
the run stops at the block unless the author wired its failure port.

What core does around it, and what that asks of you:

- **It runs your executor once, and never again.** The generic step that runs
  every integration block has no retries, so a block that posted a comment
  and then threw does not post it twice. Retrying a transient failure is
  yours, through `ctx.http`. `FatalError` from the SDK changes nothing inside
  a block; it matters in a capability adapter, which core calls from its own
  steps, where any other error may be retried.
- **One block is one step, bounded at 240 seconds.** Waiting for a person,
  looping and sleeping belong to core and are reached through a capability.
  A block that hangs is stopped and says so.
- **`ctx.run`** carries `runId`, `nodeId`, `attempt` (higher when the graph
  runs the node again, inside a Loop) and `subjectKey`, the name of what the
  run is about (a ticket key for a ticket run).
- **`ctx.llm.generateObject({ prompt, schema })`** answers with output your
  schema accepted, using the run's model. It is bounded under the 300 second
  invocation ceiling, but not by `ctx.signal`.
- **Per-run state**, for a provider that cannot be asked twice for the same
  thing: declare `runState: true` and implement `beginRun`. Core calls it once
  per run, at the run's first use of your integration, records the JSON it
  returns, and hands it to every block as `ctx.run.state` (`null` when it
  failed). Arthur needs one task per run because its API numbers a second task
  for a name that exists.

## Webhooks

A provider that calls you back posts to `/webhooks/<id>`, and core hands the
request to your `webhook.receive`. You own the transport: verify the
signature over the **raw bytes** (`request.rawBody`, before anything parsed
it), read the provider's encoding, decide who may speak. Core owns the
decision: what a ticket moving or a pull request event means for a run.

`receive` answers one of five things (`integrations/sdk/webhook.ts`):

| Answer | When | Example |
|---|---|---|
| `answered` | Verified, nothing for core to decide | Help text, an event you ignore |
| `run_control` | A person asked for a run command; core runs it, then calls your `deliver` | Slack's slash command, which has three seconds to acknowledge |
| `trigger_events` | Pull request events, normalized | GitHub, GitLab |
| `ticket_events` | Ticket events, normalized, or `ignored` with a reason | Jira |
| `refused` | Bad or stale signature (401), missing configuration (503) | All of them |

Your `reason` on a refusal goes back to the sender as the status message
(`apps/worker/src/routes/webhooks/[id].post.ts`), so keep it to what you would
tell them. Before your code runs, core answers for you: 404 when your runtime
declares no webhook, 503 when your integration is not connected here, and 202
with nothing dispatched when it is disabled, so the provider neither retries
nor switches the webhook off.

```ts file=webhook.ts
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IntegrationWebhook } from "@integrations/sdk";
import type { manifest } from "./manifest";

/** How old a signed request may be before it is treated as a replay. */
const REPLAY_WINDOW_SECONDS = 5 * 60;

/**
 * Hippo signs `<timestamp>.<raw body>` with HMAC-SHA256 and sends the hex
 * digest in `x-hippo-signature`. That sentence is the provider's, not ours:
 * read it off the provider's own page before writing this function.
 */
export function signatureMatches(input: {
  readonly rawBody: string;
  readonly timestamp: string;
  readonly signature: string;
  readonly secret: string;
}): boolean {
  const sentAt = Number(input.timestamp);
  if (!Number.isInteger(sentAt)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - sentAt) > REPLAY_WINDOW_SECONDS) return false;
  const expected = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.rawBody}`)
    .digest("hex");
  const sent = Buffer.from(input.signature);
  const wanted = Buffer.from(expected);
  return sent.length === wanted.length && timingSafeEqual(sent, wanted);
}

export const webhook: IntegrationWebhook<typeof manifest> = {
  receive: async (request, ctx) => {
    const secret = ctx.connection.webhookSecret;
    if (!secret) {
      return { kind: "refused", status: 503, reason: "no webhook secret is configured" };
    }
    const valid = signatureMatches({
      rawBody: request.rawBody,
      timestamp: request.headers["x-hippo-timestamp"] ?? "",
      signature: request.headers["x-hippo-signature"] ?? "",
      secret,
    });
    if (!valid) return { kind: "refused", status: 401, reason: "signature did not verify" };
    ctx.log.info({ bytes: request.rawBody.length }, "hippo_callback_received");
    return { kind: "answered", response: { status: 200 } };
  },
};
```

Header names arrive lowercased. One connection key is not yours in a
webhook: the route removes `legacyBotLogin` (`VCS_LEGACY_BOT_LOGIN_FIELD`)
from the connection it hands `receive`, so do not give a field that name. A
`vcs` provider's own `botLogin` field reaches `receive` as the operator set
it, unset included; it is a first filter only, and core filters review
authors and check producers again against the account it resolves. The URLs
providers already call
(`/webhooks/jira`, `/webhooks/github`, `/webhooks/gitlab`, `/webhooks/slack`)
are the same generic route, which is why an integration's id can never
change once a provider has been told where to send.

## Dashboard pages

An integration with something to show declares pages in `manifest.pages`,
ships one component per page in `dashboard.tsx`, and gives each page that
shows provider data a reader under `api` in `worker.ts`. The template has a
complete one (`integrations/_template/dashboard.tsx`), and Arthur's Evals
page is a real one.

- **The page reads what its own reader returned.** Core resolves the
  connection, calls `api[pageId]` on the server, and hands the result to the
  page as `data`: `ok` with a value, `none` when the page has no reader, or
  `unavailable` with a `cause` (`worker`: ours; `not_connected`; `provider`:
  your reader threw, with its message redacted). Read `data.value`
  defensively: the dashboard and the worker can be one deploy apart. What a
  reader returns reaches the browser, so it carries no secret.
- **A page runs only while the integration is usable.** Otherwise the area
  says why and offers Connection. A page that throws gets its own error
  screen and a slow one a loading state, with the tab strip still standing.
- **Build it from `@integrations/host-ui`**: `Page`, `Section`, `Card`,
  `KeyValue`, `Chip`, `Notice`, `EmptyState`, `ExternalLink`, `Table`. No
  primitive takes a `className`; write Tailwind classes on your own elements
  around them, with the cockpit's tokens (`integrations/host-ui/README.md`).
  The dashboard's stylesheet scans `dashboard.tsx` and anything under a
  `dashboard/` directory beside it, so keep page code there.
- **Refused, and why.** `@/...` is the dashboard's internal alias and changes
  whenever a screen needs it to. `next/*` reaches our cookies
  (`next/headers`) or moves the person (`next/navigation`), `node:*` reaches
  the filesystem, and `server-only` declares a module part of our server. The
  boundaries gate refuses all four in `dashboard.tsx` (and `@/` anywhere in
  the package). The registry generator compiles `dashboard.tsx` and the files
  it imports against what a browser has, so `process` (in the cockpit's
  server, this deployment's environment and every secret it runs with),
  `Buffer` and `require` are refused with the file and line that use them,
  and so are `globalThis`, `eval` and `Function`, which reach a global by a
  name the check cannot read. So is an import of one of Node's own modules by
  its bare name (`"process"`, `"fs"`), which the `node:` rule above does not
  see, and a `declare` statement, which would describe a global the page is
  not given. Comments and a local binding of the same name are not. There are
  no dialogs, no internal links and no form controls: pages have no write seam
  yet.
- **A page that moved here from core keeps its old address.** Declare the
  paths it used to live at in the page's `legacyPaths` (Arthur's Evals page
  declares `["/evals"]`). The dashboard builds a permanent redirect to the page
  from each one in `next.config.ts`, so bookmarks and links in old messages
  keep working. Each is one lowercase segment, and conformance refuses
  anything else or a path declared twice; the dashboard's own tests refuse one
  that a live screen serves or another page already claims.
- **Import the manifest with `import type`** in `dashboard.tsx`, so its zod
  schemas never reach the browser, and declare the pages with
  `defineIntegrationDashboard<typeof manifest>({ pages })`: a declared page
  without a component, or a component nobody declared, is a compile error.

## MCP

Integrations contribute no MCP tools, and there is nothing for you to write.
Connecting, testing, enabling and choosing a provider are dashboard actions
only, so a credential never passes through a chat with a model.
`system.capabilities` lists your integration, whether it is usable, the
capabilities it declares and its blocks, computed by the same resolver as the
editor's palette, and, per capability, which provider serves it on this
deployment (the Integrations page's Capabilities rows). Anything an agent
reads has your declared variable names replaced, which is why a name shorter
than four characters is refused, and a refusal sentence about your connection
is replaced whole by one that names no configuration.

## Testing without our production credentials

**Conformance** (`pnpm --filter @integrations/registry run test`) finds every
package under `integrations/` without being told, so yours is covered the day
it lands. It imports your manifest and runtime and checks them against the
contract: ids and block types, reserved names, secrets flagged, an executor
per block, an adapter per capability, a probe per check, a reader only for a
declared page, `beginRun` exactly when `runState` is declared, no workflow
directive in any file, and no one-argument `z.record` in a block's parameter
schema. `pnpm run test:packages:zod4` runs the same suite again against zod 4.

**Your own tests** exercise your code against a context you build, with no
network and no credential:

```ts file=webhook.test.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { IntegrationContext } from "@integrations/sdk";
import type { manifest } from "./manifest";
import { webhook } from "./webhook";

/**
 * A delivery the provider signed, downloaded from its documentation. The file
 * beside it, `signed-delivery.source.txt`, says where from, on which date,
 * and the SHA-256 of these bytes.
 */
const recorded = JSON.parse(
  readFileSync(new URL("./test-fixtures/signed-delivery.json", import.meta.url), "utf8"),
) as { secret: string; timestamp: string; signature: string; rawBody: string };

function context(webhookSecret: string | undefined): IntegrationContext<typeof manifest> {
  return {
    connection: {
      baseUrl: "https://api.hippo.example",
      projectId: "p_1",
      apiKey: "not-used-here",
      webhookSecret,
    },
    http: { fetch: () => Promise.reject(new Error("this test makes no request")) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    signal: AbortSignal.timeout(1_000),
  };
}

function delivery(overrides: { rawBody?: string } = {}) {
  return {
    method: "POST",
    rawBody: overrides.rawBody ?? recorded.rawBody,
    headers: { "x-hippo-timestamp": recorded.timestamp, "x-hippo-signature": recorded.signature },
    query: {},
  };
}

test("accepts the delivery the provider itself signed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(recorded.timestamp) * 1000 });
  const reception = await webhook.receive(delivery(), context(recorded.secret));
  assert.equal(reception.kind, "answered");
});

test("refuses the same bytes with one character changed", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Number(recorded.timestamp) * 1000 });
  const reception = await webhook.receive(
    delivery({ rawBody: `${recorded.rawBody} ` }),
    context(recorded.secret),
  );
  assert.deepEqual(reception, { kind: "refused", status: 401, reason: "signature did not verify" });
});

test("says the deployment was never given a secret, rather than that the sender is wrong", async () => {
  const reception = await webhook.receive(delivery(), context(undefined));
  assert.equal(reception.kind, "refused");
  assert.equal(reception.kind === "refused" && reception.status, 503);
});
```

The scaffold ships the runner and a first test (`worker.test.ts`): a `test`
script, `node --import tsx --test "!(node_modules)/**/*.test.{ts,tsx}" "*.test.{ts,tsx}"`,
and `test:zod4`, the same files under the zod production loads through
`../../packages/zod4-alias.mjs`, with `tsx` and `zod4` in `devDependencies`.
Keep both globs: Node's runner reads a bare `"*.test.ts"` as the package root
only, so a test beside page code in `dashboard/` would never run and a test
broken on purpose would stay green. GitHub, GitLab and Jira use `vitest run`
instead, which finds nested files on its own. Then add
`--filter @integrations/<id>` to the root `test:packages` and
`test:packages:zod4` scripts in `package.json`: those lists are what CI runs,
and `scripts/ci/verify-changed.test.ts` fails when a package that owns a
`test` script is missing from them, when a test file in a package is one its
script does not run, and when a package has a `test` script and no test.

### Recorded payloads

A test of how you read a provider's payload is worth what its bytes are
worth. Record real ones and keep their provenance beside them, as
`integrations/github/test-fixtures/*.source.txt` do: the URL, the pinned
revision, the retrieval date and the SHA-256 of the bytes, with the digest
pinned in a test so a fixture reshaped to make an assertion pass fails loudly.

A recorded payload **signed by the same function that verifies it proves
nothing**: sign and verify agree with each other whatever the header, the
encoding or the string that is signed, so the test passes and the provider's
first real delivery is refused. You find out from the provider's delivery log,
and a provider that meets enough failures switches the webhook off. Use a
signed example the provider published (Slack's is
`integrations/slack/fixtures/signed-slash-command.json`: secret, timestamp,
body and signature all Slack's). When the provider publishes payloads without
signatures, as GitHub and GitLab do, sign them in the test with a helper
short enough to read against the provider's page, and say so beside it.

### zod 3 in tests, zod 4 in production

The workspace pins zod 3 and every local run uses it. The deployed worker
bundle resolves zod 4, traced from the Workflow DevKit. Where the two majors
disagree, a schema passes every local test and fails in production at its
first parse: a one-argument `z.record(value)` does not exist in zod 4 (write
`z.record(z.string(), value)`), and `.default()` short-circuits in zod 4 and
applies inside `.optional()`, where zod 3 did neither. Conformance checks your
block parameter schemas under both; the schemas in your worker code that read
a provider's answers are checked only by your own `test:zod4`. Always write
`z` from `@integrations/sdk`, never your own `zod` dependency.

### On a deployment

Prove a connection on a deployment you are allowed to change, never against
production and never with production's credentials. Do not start a worker
locally to do it: on our machines `DATABASE_URL` points at production, and the
worker's build runs migrations against whatever it points at. On a preview
or on the demo deployment, writes on the Connection tab are refused (see
"Where the values come from"), so set your provider's variables on that
deployment and redeploy. The integration then reads Connected (environment),
its card and pages appear, the health page runs your probes, and a workflow
can use your blocks. Removing the variables and redeploying is how you
disconnect it there. `integrations/_fixtures/demo` is a provider with no
network at all, registered only in a registry a developer generates locally
with `INTEGRATION_FIXTURES=1 pnpm run gen:integrations`. No deployment and no
CI job sets that flag, the committed registry is the one generated without it,
and `gen:integrations --check` compares against that whatever the flag says;
tests that need the fixture ask the generator for it directly. Copy its
approach for a network-free double of your own.

## Things you may not do, and what happens if you do

| If you | What breaks, and when you find out |
|---|---|
| Import a Node module or a provider SDK into `manifest.ts`, directly or through a file it imports | The Workflow DevKit's flow bundle fails the Vercel build, and nothing local would notice. `pnpm run gen:integrations` refuses it first, naming the import. |
| Use a global the Workflow DevKit's VM lacks in `manifest.ts` or a file it imports (`Buffer`, `EventTarget`, `setTimeout`, `fetch`, `process`), one it makes differ (`Date`, `Math.random`, and `crypto`, whose `randomUUID` and `getRandomValues` it seeds), or one that reaches past the check (`globalThis`, `eval`, `Function`, a `declare` statement) | Conformance and the typecheck run in Node and pass; the deployed workflow throws a ReferenceError, hits a stub that throws, or reads a value the dashboard does not see. `pnpm run gen:integrations` refuses it first: it compiles the manifest's files against the language plus what the VM provides (`WORKFLOW_VM_GLOBALS` in `scripts/gates/generate-integration-registry/graph-globals.ts`, held to the pinned DevKit by a test) and names each use with its line. A type that mentions `Buffer`, or a local named `process`, is not a use. |
| Put `"use step"` or `"use workflow"` in integration code | A step's identity is its module path plus its function name (the DevKit's id is `step//<module path>//<function>`), so a step inside your package would strand every run suspended in it the day the package moved or was renamed. Conformance refuses the directive in any file of the package. |
| Put your provider's word into a shared type, or core's code | The next provider cannot implement the port without inventing a meaning for your word, and core grows a branch on your name. The core-reference gate fails on any core file that spells a shipped integration's id, its package names and the identifiers built from it included (`jira-client`, `JiraAdapter`). |
| Pick an id core source already spells | The core-reference gate fails your first run on every core file that spells it where no allowlist row covers it (the rule is quoted under "From nothing to a connected integration"). `new:integration` refuses such an id and names the files. |
| Parse with a zod feature zod 4 changed | Production fails at the first parse while every local test passes. |
| Test a webhook against bytes you signed yourself | The provider's first real delivery is refused, discovered from its delivery log. |
| Return `{ ok: false }` from `testConnection` for a timeout or a 5xx | A provider blip while an admin presses Test marks the connection Failing and stops every run until somebody presses Test again. |
| Read your configuration from `process.env` | It bypasses the source an admin chose, is not pinned or redacted, and is missing on a deployment connected from the dashboard. |
| Give a block a second port, or a parameter with no default | The port is refused by the generator. The parameter cannot be set in the editor, so the block cannot be published from it. |
| Rename a block type, a status variant or the id after shipping | Stored workflows stop resolving the block or take another branch; the id is also written into stored rows (`ticket:jira:<KEY>` for every Jira run), so renaming it is a migration, not an edit. |
| Rename a connection field's key or `env`, or change its default or `identity`, after shipping | Every run in flight through the integration stops with `reconfigured` on every deployment that set it. The connection-shape snapshot test makes the change visible in review; the drain happens before merge. |
| Import another integration, `@shared/*` or anything in `apps/` | The boundaries gate and conformance refuse it. The SDK re-exports what you need from `@shared/contracts`. |
| Return a secret from a page reader, or put one in a message | A reader's value reaches the browser. Messages and logs are redacted against your declared secrets, values are not. |
| Leave a fetch in a page or a probe unbounded | A page is what the cockpit waits on, and a probe that hangs is cut off as down. |

## Before you open a pull request

```sh
pnpm install
pnpm run gen:integrations
pnpm --filter @integrations/<id> run typecheck
pnpm --filter @integrations/registry run test
pnpm --dir apps/worker exec vitest run src/services/integrations/connection-shape.test.ts
pnpm run gate:core-references
pnpm run verify:changed -- --worktree
```

- The package's README says what it connects, which values an admin needs and
  where to find them, what connecting unlocks, and which provider pages you
  read and when.
- `changelog/unreleased/<slug>.md` carries one bullet saying what a person can
  do now (`changelog/README.md` has the tone rule).
- The pull request says which provider documentation the adapter was written
  against, and, for a change to an integration that has shipped, which
  connection shapes and block types moved.

## Where to look

| For | Open |
|---|---|
| Every type and its rule | `integrations/sdk`: `manifest.ts`, `context.ts`, `runtime.ts`, and one file per port |
| What conformance refuses, with each rule's sentence | `integrations/sdk/conformance.ts` |
| The starting point | `integrations/_template`, and `scripts/gates/new-integration.ts` which copies it |
| A tracing provider, per-run state, a block that must be read, a page with data | `integrations/arthur` |
| One active messaging provider, a slash command, a probe that cleans up after itself | `integrations/slack` |
| A per-repository provider on a self-hosted host | `integrations/gitlab` |
| A credential that is not a token, recorded webhook payloads with provenance | `integrations/github` |
| The one issue tracker, ticket events, a permanent id | `integrations/jira` |
| The built-in memory provider | `apps/worker/src/memory/builtin/adapter.ts`, `apps/worker/src/engine/support/memory-runtime.ts` |
| A provider with no network, for demos | `integrations/_fixtures/demo` |
| Why any of this is shaped the way it is | [ADR-010](../adr/ADR-010-integrations.md) |
