Status: draft
Last-verified: 2026-09-15

# Repository work scope: one answer to "which repositories does this work touch"

Planned on 2026-09-15 from a read-only recon of `main` at
`3f8d4d5ea4e6413734d753d4e17b1c2f29a96e73`, after the production campaign for
AIW-377 and the review of pull request #482 found the defect recorded as
AIW-402. The owner asked for one coherent product, not a patch: "per trigger"
and "per ticket" have to be one system, and a person must never be asked the
same repository question twice.

## Problem

The question "which repositories does this piece of work touch" is answered in
five places, each with its own rules and none of them durable: the repository
catalog (what exists and is enabled), the repository pin on a workflow
definition, the pre-sandbox selection from the ticket text, the in-run
expansion protocol the research agent uses, and the repository list an approved
plan carries into the next run. A run derives the answer again from scratch,
and a person's answer to a repository question lives on the run that asked it.

What a person sees:

1. A run asks which repository to use, the person answers, a later run on the
   same ticket asks again, or applies the old answer blindly. On production the
   old "none" of a previous run closes expansion in the new run before anyone
   is asked, so the advice "enable the repository and start a new run" ends in
   a run that fails at once (AIW-402).
2. The research agent never sees the catalog. Its prompt carries only the
   repositories already attached, so it names the repository it needs from
   memory, often one the deployment cannot use, and every such guess becomes a
   question to a person.
3. A vague ticket that genuinely touches several repositories trips the "more
   than three matches" rule or a medium confidence verdict and asks a person
   even when the catalog descriptions and relationships would have settled it.
4. Nobody can see or correct what the system decided for a ticket. The
   Repositories page edits the catalog, the run view shows the enabled list
   frozen at start, and there is no per-ticket record at all: a ticket is a key
   referenced by runs, clarifications and approvals.
5. When a run does take the wrong repository, nobody can say why. What the
   agent was shown, what it asked for, what was refused and on what grounds sit
   in places that do not join: a run log line, a clarification row, a sandbox
   registry row. Answering "why this repository" is an archaeology session
   today, and it is the question asked every time a run disappoints.

## Solution

From the user's side, four layers that only narrow each other, with the
person's decision kept in the layer that outlives a run:

1. **Catalog** (the deployment): what exists, what is enabled, what each
   repository is for and how it relates to the others. Unchanged.
2. **Trigger repository policy** (per trigger of a workflow definition): which
   subset of the catalog runs started by this trigger may consider, and what
   happens when the work needs a repository outside it: attach it on its own,
   ask a person once, or never. A ticket trigger defaults to the whole enabled
   catalog and attaches on its own; a pull request trigger defaults to its
   event's repository plus what the catalog says is related to it; a schedule
   and a webhook that cannot name its subject take exactly the list they were
   configured with and nothing else. This is the roadmap's P1 item "configure
   visible repository scope per trigger instead of globally", delivered here.
3. **Work scope** (per subject of finite work: a ticket, a pull request, a
   webhook delivery whose endpoint can name its subject): a durable, typed
   record of which repositories this work touches and how each entry was
   decided. Every run on the subject inherits it, every decision made during a
   run writes into it, and a person can read and edit it on the ticket screen
   and through MCP. A repository is asked about at most once per subject, ever.
   A schedule and an unnameable webhook delivery carry no record at all,
   because every firing is a new subject: for them layer 2 is the whole answer.
4. **Decision trail** (per subject and per run): every repository decision as
   an appended line saying what was decided, what decided it, on what input,
   and what the agent had been shown at that moment. This is what a person
   opens when a run took the wrong repository, and it is readable through MCP
   without a browser.
5. **Run workspace** (per run): what was actually cloned. Already recorded,
   stays immutable evidence.

And the agent gets a **repository map** instead of guessing: a compact index of
the repositories it may consider (key, one sentence of purpose, relationship
edges to what is already attached), ranked and capped so it costs a few hundred
tokens, with the full profile only for attached repositories and on request.

## User stories

1. As a client user I want a ticket that names its repository to run without
   any repository question, so that precise tickets cost no attention.
2. As a client user I want a vague ticket to be matched against what the
   repositories are for and how they relate, so that the agent picks the right
   one or several on its own and asks only when it genuinely cannot decide.
3. As a client user I want to answer a repository question once per ticket and
   have every later run on that ticket honour it, so that I am never asked the
   same thing twice.
4. As a client user I want "continue without that repository" to mean exactly
   that for this ticket, and I want enabling that repository later to make the
   next run take it without asking, so that the advice the system gives me
   actually works.
5. As a client user I want to see on the ticket which repositories the work
   touches, why each is there, and who decided, and to add, remove or exclude
   one by hand, so that I can correct the system without a new run.
6. As an operator I want each trigger to declare which repositories its runs
   may consider and whether they may reach beyond that, so that a pull request
   event never pulls in a second repository while a ticket may.
7. As an integration author I want the same read and edit of the work scope
   through MCP that the dashboard has, so that the parity rule holds.
8. As a maintainer I want the research agent to request repositories by
   catalog identity from a map it was shown, so that a request for a
   repository the deployment cannot use is a rare event with a clear reason,
   not the normal case.
9. As an operator debugging a run I want one place that tells me which
   repositories the run used, what it was shown about them, every question it
   asked with the answer it got, and what decided each entry, so that I can
   tell within a minute whether the system chose wrongly or the ticket was
   unclear.
10. As an integration author I want that same trail through MCP, readable by
    run and by subject, so that debugging an agent never requires a browser
    session or a database query.

## Implementation decisions

### Vocabulary

- **Work scope**: the per-subject record. Its entries are repositories with a
  state (`selected`, `excluded`, `unavailable`), a reason when unavailable
  (`not_enabled`, `unusable`), an origin (`ticket_text`,
  `workflow_owned_branch`, `trigger_policy`, `inferred`, `person`), a short
  rationale, who and when decided, and the run that decided.
- **Who carries a record**: only a subject that is a finite piece of work. A
  ticket, a pull request, and a webhook delivery whose endpoint resolves a
  subject id from the payload each carry one, keyed on the subject key they
  already have, unchanged. A schedule and a webhook endpoint with no subject
  path carry none. No key is ever rewritten, and two occurrences of one
  schedule cannot race over one row.
- **Trigger repository policy**: on a trigger node of a workflow definition, a
  candidate set (the whole enabled catalog, or an explicit list of catalog
  keys) and an expansion rule (`attach`, `ask_once`, `never`). Absent policy
  means the defaults for that trigger kind, with the existing definition-level
  repository pin, where one exists, as the candidate set. The name "repository
  scope" stays with the definition pin it already denotes. Structurally the
  policy is a new optional field group inside the trigger node's own
  `configuration`, added as one shared parameter spread exactly the way
  `triggerRateLimitParams` already is
  (`apps/worker/src/engine/definition/block-params-schemas.ts:60-64`) and
  applied to all EIGHT distinct trigger configurations behind the TEN trigger
  types the registry carries (`:294-303`), with `trigger_plan_approved` left
  out deliberately, because an approved plan carries its own frozen scope. Six
  of those ten types are pull request triggers, so "the pull request default"
  below means all six, not one. It is NOT an extension of
  `WorkflowRepositoryScope`, which is pinned to the whole definition
  (`packages/contracts/domain.ts:676`,
  `packages/workflow-graph/schema.ts:326`), read at dispatch
  (`apps/worker/src/services/dispatch/dispatch-trigger.ts:270`,
  `apps/worker/src/services/manual-dispatch/resolve.ts:369`) and applied in a
  run by `filterPinnedRepositories`
  (`apps/worker/src/adapters/vcs/repository-directory.ts:177-190`).
- **Repository map**: the compact index rendered into the agent's context.
- **Decision trail**: the append-only history behind a work scope. The entries
  are its fold; the trail is why each entry looks the way it does.

These four terms go into CONTEXT.md when stage 1 freezes the contract.

### The contract (binding names and shapes)

Stage 1 freezes exactly this in `@shared/contracts`. Everything later imports
it; a stage that needs a different shape returns a question instead of
widening it.

```ts
export const WORK_SCOPE_ENTRY_STATES = ["selected", "excluded", "unavailable"] as const;
export const WORK_SCOPE_UNAVAILABLE_REASONS = ["not_enabled", "unusable"] as const;
/** Index order IS precedence: index 0 wins. */
export const WORK_SCOPE_ORIGINS = [
  "person", "workflow_owned_branch", "ticket_text", "trigger_policy", "inferred",
] as const;
export const WORK_SCOPE_REFUSAL_REASONS = [
  "outside_catalog", "outside_policy", "excluded", "unavailable",
  "workspace_cap", "rounds_exhausted",
] as const;

/** The normalised catalog key a run's frozen enabled list already carries:
 *  lower case "provider:path", e.g. "github:blazity/ai-workflow-demo". */
type RepositoryKey = string;

type WorkScopeActor =
  | { kind: "person"; actorId: string; actorLabel: string }
  | { kind: "run"; runId: string; definitionId: number; definitionVersion: number; model?: string };

type WorkScopeEntry = {
  repositoryKey: RepositoryKey;
  state: WorkScopeEntryState;
  unavailableReason?: WorkScopeUnavailableReason; // present exactly when state is "unavailable"
  origin: WorkScopeOrigin;
  rationale: string;                              // at most 500 characters
  decidedBy: WorkScopeActor;
  decidedAt: string;                              // ISO 8601
};

type WorkScope = { subjectKey: string; version: number; entries: WorkScopeEntry[] };

type WorkScopeTrailEvent =
  | { kind: "entry_written"; entry: WorkScopeEntry; previousState: WorkScopeEntryState | null; clarificationId?: string }
  | { kind: "question_asked"; clarificationId: string; repositoryKeys: RepositoryKey[] }
  | { kind: "request_refused"; repositoryKey: RepositoryKey; reason: WorkScopeRefusalReason }
  | { kind: "map_shown"; text: string; repositoryKeys: RepositoryKey[] }; // text at most 1600 characters

/** subjectKey and runId are never both null: a panel edit has no run,
 *  a schedule run has no subject. */
type WorkScopeTrailRow = { id: number; subjectKey: string | null; runId: string | null; at: string; event: WorkScopeTrailEvent };

type TriggerRepositoryPolicy = {
  candidates:
    | { kind: "enabled_catalog" }
    | { kind: "event_repository_and_related" }             // the six pull request trigger types only
    | { kind: "listed"; repositoryKeys: RepositoryKey[] };  // 1 to 50, unique
  expansion: "attach" | "ask_once" | "never";
};

/** A person's edit. One write, whole change set, one version. */
type WorkScopeEditRequest = {
  subjectKey: string;
  expectedVersion: number;                                  // 0 when the subject has no record yet
  changes: Array<{ repositoryKey: RepositoryKey; action: "select" | "exclude" | "remove"; rationale?: string }>; // 1 to 16, one per key
};
```

- `remove` deletes the entry and lets the next run decide again, so a
  repository the ticket names comes straight back. `exclude` is the sticky
  refusal. The panel says which is which in its copy, because the difference is
  invisible otherwise.
- The contract also carries two pure functions, because the dashboard needs
  them for placeholders and cannot import the engine:
  `resolveTriggerRepositoryPolicy({ triggerType, configured, definitionPin, webhookHasSubjectPath })`
  returns the effective policy (the A2 defaults, the definition pin as a
  `listed` candidate set when no policy is configured, and nothing at all for
  `trigger_plan_approved`); and
  `validateTriggerRepositoryPolicy(triggerType, policy, { webhookHasSubjectPath })`
  returns the semantic issues: `event_repository_and_related` outside the six
  pull request types, `ask_once` on a schedule, `ask_once` on a webhook with no
  `subjectPath`, duplicate listed keys. Shape is refused by the `.strict()`
  params schema when a draft is saved; semantics are refused when a version is
  published, the way an incomplete schedule already is.

### Work subjects and recurring channels

The record exists for finite work and does not exist for a recurring channel.
That asymmetry is what makes one mechanism safe for both.

- A **ticket**, a **pull request** and a **webhook delivery with a resolved
  subject id** are finite work. Their scope accumulates across runs and is
  inherited, which is the guarantee that a person is asked at most once about a
  repository.
- A **schedule** and a **webhook endpoint with no subject path** are recurring
  channels. Every firing and every delivery is a new subject key
  (`apps/worker/src/engine/support/subject-key.ts:42-48`,
  `apps/worker/src/services/webhook-trigger/dispatch-webhook-trigger.ts:122-158`),
  so a record would be written once and never read again, and "ask once" would
  mean "ask every delivery". They carry no record at all: their repositories
  are the trigger policy, a person changes them by editing the trigger, and
  their expansion rule is `never`.

### The work scope state machine

- Precedence of origins, highest first: `person`, `workflow_owned_branch`,
  `ticket_text`, `trigger_policy`, `inferred`. A lower origin never overwrites
  a higher one for the same repository. An origin does overwrite its own kind:
  the text match runs on every run, so a corrected ticket replaces the
  `ticket_text` entry it wrote before, and `workflow_owned_branch` is a fact
  about the branch and is re-derived per run. Only `person` is sticky against
  re-derivation.
- A question to a person about a repository is raised only when the work scope
  holds no entry for it. The answer writes the entry, so the question cannot
  recur on the subject.
- "Continue without it" answered to an unavailable repository records that
  repository as `unavailable` with the person as decider, not as `excluded`:
  the person could not give it, they did not refuse it. `excluded` is written
  only by an explicit edit on the ticket screen or through MCP.
- An `unavailable` entry carries the reason it was unavailable, and only
  `not_enabled` expires: at run start the record is reconciled against the
  catalog snapshot the run froze, and an entry the catalog now enables becomes a
  candidate the agent may attach without a question. An `unusable` entry (the
  catalog holds no default branch for it, so `usable` is false at
  `apps/worker/src/engine/repository-discovery/catalog.ts:193`) does not expire
  on an enable, because being enabled was never why it failed. Nothing expires
  while the catalog is a bridge (`activated: false`), where every repository
  answers enabled and an expiry would ask the person a second time. An
  `excluded` entry never expires.
- A `selected` entry whose repository is no longer enabled in the catalog is
  kept but does not attach; the run reports it in its status reason and the
  ticket screen shows it as unavailable. Nothing is asked.
- The trigger policy bounds every attach, inherited entries included. A
  `selected` entry another workflow wrote is attached only when it also sits in
  this trigger's candidate set; otherwise the run works without it, says so in
  its status reason, and asks nobody. Without that rule a narrow trigger would
  be widened by whatever a broader workflow once recorded on the same ticket,
  because the subject key carries no definition
  (`apps/worker/src/engine/support/subject-key.ts:3-5`). One exception, and it
  is the whole reason a person may edit at all: an entry whose origin is
  `person` is never filtered. A person outranks a policy, because the policy is
  a default for machines. Everything else inherited is filtered, `ticket_text`
  included, because what a ticket says does not decide what THIS workflow is
  allowed to touch.
- Outside the candidate set the expansion rule decides: `attach` attaches and
  records `inferred`; `ask_once` asks and records the answer, so the subject is
  asked at most once; `never` refuses with the policy named in the reason. A
  person's edit may add any enabled catalog repository regardless of the policy,
  and the entry carries their identity.
- Guard rails already in the expansion protocol stay: the eight repository
  workspace cap, the two expansion rounds, the three per request. An automatic
  attach counts as a round. The cap counts `selected` entries only and is
  enforced where one is WRITTEN, with a reason naming it, so an inherited scope
  can never exceed it and can never raise the "which repositories are
  essential" clarification about repositories settled in an earlier run
  (`apps/worker/src/engine/repository-discovery/runner.ts:386-390`). `excluded`
  and `unavailable` entries are not workspace members and are never capped: a
  ticket where a person answered "continue without it" eight times must still
  record the ninth, or the promise breaks exactly at the limit. A panel edit
  that swaps one repository for another is ONE write of the whole entry set
  carrying a version, never a remove followed by an add.
- Every write is one statement with an optimistic version, because production
  has no interactive transactions. Concurrent writers (a run and a person) get
  a version conflict, never a lost update.

### What stops re-deriving

- Pre-sandbox selection starts from the work scope. Only a subject with no
  scope runs the existing matching over the ticket text; its result is written
  as the first entries.
- The in-run expansion validator consults the work scope before the catalog:
  an `unavailable` or `excluded` entry answers the request without a question.
- An approved plan stays frozen. The approval row keeps the immutable
  repository snapshot it already carries
  (`apps/worker/src/services/approvals/dispatch.ts:162`), a `plan_approved` run
  reads that snapshot and nothing else, writes nothing back to the scope, and
  keeps refusing expansion outright
  (`apps/worker/src/engine/agent-workflow.ts:1690-1697`). The subject's scope
  may move on between approval and execution, and it must not reach a run a
  person approved, or that run would clone and write to a repository nobody
  approved.
- A previous run's clarification answers stay in the agent's context and in
  the trigger output as history; they no longer steer repository decisions.
  The only place that re-applied them, the human expansion re-read at the top
  of the research loop, reads the work scope instead.

### The repository map

- Deterministic, no model call, so it costs nothing to compute and replays the
  same. Ranking: first the catalog relationship neighbours of attached
  repositories (two hops), then repositories whose description or key matches
  ticket terms, then repositories this subject's scope already holds, then the
  rest by catalog key.
- Twelve lines is the cap only when the catalog holds more than twenty five
  repositories; below that the whole catalog is rendered. The cap exists to
  bound context, not to hide choices, and it bites hardest exactly where the
  map is needed: on the discovery path nothing is attached yet, so the
  relationship ranking has no anchor and only the lexical signal is left, and
  that signal is the one that already failed when the ticket was ambiguous
  (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:974-980`).
- The map never narrows what may be requested. A request is refused only for a
  key outside the catalog or outside the trigger policy's candidate set, never
  merely for a key the map did not show, and the agent may ask for the rest of
  the map in one further request. Discovery hands the model the whole catalog
  today, so a map that gated requests would be a regression.
- Each line is the catalog key, the first sentence of the description cut at
  about 120 characters, and the relationship kinds to attached repositories. The
  full profile (description, rules, relationships) is rendered only for attached
  repositories, as today.

### The decision trail

The record answers "which repositories". The trail answers "why, and what did
the agent actually see". Most of the second answer is already being written and
nobody reads it.

- **Per subject**: every write to a work scope appends one line carrying the
  repository, the state it moved to, the origin, a free text reason, the actor
  (a person with their identity, or the run and the model that decided) and the
  time. The entries are the fold of that trail, materialised so a run start
  reads one row rather than a history.
- **A trail row carries a subject, a run, or both, and never neither.** A panel
  edit has no run; a schedule run has no subject and still leaves a readable
  trail of what it did with repositories. The entries a subject
  accumulates are the fold of the rows that carry a subject.
- **The repository a question is about is recorded when the question is ASKED,
  never when it is answered.** The clarification row has no repository column
  (`apps/worker/src/db/clarifications-schema.ts:13-53`) and the answer path
  receives the row, the raw answer and the actor and nothing else
  (`apps/worker/src/services/clarifications/answer-core.ts:179`), so by answer
  time the identity is gone unless the ask wrote it down. Without this the
  central promise breaks exactly where it matters: "continue without it" would
  append a line naming no repository, no entry would be created, and the next
  run would ask again.
- **Three carriers, all of them steps that already exist.** An attach rides
  `attachResearchRepositoriesStep` (`apps/worker/src/engine/steps/phase.ts:527`,
  its existing write at `:581`), which is on the stack for both the model's
  expansion and a person's answer (`apps/worker/src/engine/agent-workflow.ts:1762`
  and `:2013`). A question rides the step that parks the run and publishes the
  clarification. A refusal that asks nobody rides the step that writes the
  run's status reason. Naming a carrier per outcome is required, because the
  decision functions themselves run in WORKFLOW scope
  (`apps/worker/src/engine/agent-workflow.ts:1705-1725`), where a write would
  be repeated on every replay of a parked run and would break determinism.
  No new `"use step"` is added anywhere, which is what keeps runs in flight
  alive.
- **A run's own writes never carry an optimistic version.** They merge by
  origin precedence in one insert-on-conflict statement.
  `attachResearchRepositoriesStep` runs with `maxRetries = 0`
  (`apps/worker/src/engine/steps/phase.ts:607`), so a version conflict there
  would kill the run after its sandbox already exists, with an opaque error.
  The optimistic version belongs to the person's edit, where a conflict is
  meaningful and recoverable.
- **Per run, already recorded, but not always**:
  `workflow_runs.analysis_report` holds the repositories a run worked on with
  their access and rationale, its rounds, the model's requests and its write
  targets (`apps/worker/src/db/schema/runs.ts:93`, built in
  `apps/worker/src/engine/support/run-analysis-report.ts:44-81`), and no MCP
  tool mentions it. It is written only after a phase completes
  (`apps/worker/src/engine/agent-workflow.ts:1052`, `:2377-2421`, `:2515-2553`,
  `:3210-3241`), so a run that dies in discovery or expansion, which is exactly
  the run someone wants to debug, has none. The trail is therefore the primary
  record and the report is the richer view layered on top when it exists.
- **The prompt is already durable; the map still is not.** The rendered text
  reaches the model as the `inputContent` of `writeAndStartPhase`
  (`apps/worker/src/engine/steps/phase.ts:300-368`), a step, so it is
  journalled and `runs.diagnose` and `runs.logs` return it verbatim. That
  answer is attempt-scoped, truncated at 32 KB and unstructured. The map is
  recorded as one bounded trail row at render time, so "what was it shown about
  repositories" has a structured answer, and the prompt stays exactly where it
  already lives rather than being copied.

### Surfaces

- Worker API: read and update the work scope by subject, versioned, and read
  one run's repository report. Three MCP tools mirror them one to one:
  `work_scope.get` (entries, trail, and the questions asked with their
  answers), `work_scope.set` (edit carrying a version), and
  `runs.repositories` (what this run used and why, its rounds, the requests it
  made with the verdict on each, and the map it was shown). That last tool
  earns its place next to `runs.diagnose` and `runs.logs` because those answer
  per attempt, truncate at 32 KB and return text a reader must parse, while
  this one answers per run, structurally, and works for a run that failed
  before any report existed. They join the tool catalog with the policy the other subject-level and run-level
  tools use; the contract is regenerated.
- Dashboard: a panel on the existing ticket screen listing the entries with
  state, origin, rationale and decider, with add, remove and exclude actions
  that send the version and surface a conflict the way the repository profile
  editor does. The run view keeps its frozen enabled-list line and gains the
  same repository report the new run-level tool returns, so the browser and MCP
  answer "why this repository" identically.
- Trigger policy: one field group on the trigger node in the flow editor, with
  the kind defaults shown as placeholders; validated by the workflow graph
  package like every other trigger field.

### Replay and drain

- Loading the work scope happens inside the run-start step that already
  freezes settings and the catalog, as one more field of its output. That step
  runs before every other step, so the change merges only after a production
  drain, and a replayed output without the field puts that run on the WHOLE old
  path, clarification re-read included, until it finishes. There is no half-new
  path: a run either carries a scope or behaves exactly as it did before the
  deploy.
- The drain is counted in the database, never through a helper named terminal:
  zero agent-workflow rows in `workflow_runs` with status `running` or
  `awaiting`, and zero rows in `active_runs`. `isTerminalRunStatus` counts
  `awaiting` as terminal while such a run is alive and parked on a person
  (`apps/worker/src/services/mcp/contracts.ts:216-217`), so anything built on it
  would call a board full of parked runs drained.
- No step, hook or sleep is added, removed or reordered anywhere else. Every
  decision is a pure function fed from the run context.

## Seams and test decisions

| Seam | Observed behaviour | Prior art |
|---|---|---|
| Work scope decision (pure) | given a scope, a catalog snapshot, a trigger policy and a request or answer, returns the next scope and the action (attach, ask, refuse, record) | `decideRepositoryExpansion` in `apps/worker/src/engine/repository-discovery/runner.ts:612` and its tests in `apps/worker/src/services/repository-discovery/runner.test.ts:979` |
| Subject eligibility (pure) | a ticket, a pull request and a webhook delivery with a resolved subject id carry a record; a schedule and a subject-less webhook carry none and read their policy instead | `apps/worker/src/engine/support/subject-key.ts:15-48`, `apps/worker/src/services/webhook-trigger/dispatch-webhook-trigger.ts:155-158` |
| Work scope store | one-statement versioned upsert, read by subject, conflict on a stale version | `apps/worker/src/db/repositories/repository-catalog.ts` (profile versions) and the neon-http rule in `apps/worker/AGENTS.md` |
| Run-start freeze | the run context carries the scope beside `ctx.settings` and `ctx.repositories`; a replayed old output leaves it absent | `apps/worker/src/engine/steps/run-start-settings.ts:67` |
| Selection from scope | a subject with a scope skips text matching; without one, matching writes the first entries | `selectRepositoriesFromMetadata`, `apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:745-981` |
| Expansion from scope | an entry answers a request before the catalog is consulted; the human re-read at the top of the research loop reads the scope, not other runs' answers | `applyHumanRepositoryExpansion`, `apps/worker/src/engine/steps/phase.ts:105-164`; `validateRepositoryExpansionRequests`, `runner.ts:277-392` |
| Repository map rendering (pure) | ranked, capped index text from a catalog snapshot, attached keys, ticket terms and the scope | `apps/worker/src/sandbox/context.ts:129-161` (research prompt), `assembleRepositoryDiscoveryPrompt`, `runner.ts:56-97` |
| Trigger policy validation | a trigger node with a policy validates; unknown keys and an expansion rule the kind does not allow are refused | the per-kind `.strict()` config schemas at `apps/worker/src/engine/definition/block-params-schemas.ts:66,131,199,294` and their tests in `block-params-schemas.test.ts:10` |
| Decision trail append, run side | an attach, a refusal or an automatic choice appends one line naming the repository, the origin and the reason, inside the step that already attaches and already writes | `attachResearchRepositoriesStep`, `apps/worker/src/engine/steps/phase.ts:527` with its existing write at `:581`; the actor and reason columns of `repository_profile_versions`, `apps/worker/src/db/repositories/repository-catalog.ts:556` |
| Decision trail append, person side | answering a repository question appends the same shape from the API side, never from inside the run | `answerConnectedClarificationAndResume`, `apps/worker/src/services/clarifications/answer-core.ts:179` |
| Run repository report (read) | one read returns what a run used and why, its rounds, its requests with verdicts, and the map it was shown | `workflow_runs.analysis_report`, `apps/worker/src/db/schema/runs.ts:93` and `apps/worker/src/engine/support/run-analysis-report.ts:44-81`, unread by any MCP tool today |
| MCP parity | `work_scope.get` and `work_scope.set` answer exactly what the API routes answer | `apps/worker/src/mcp/tools/repositories.ts:363` and `pnpm run mcp:contract:generate` |
| Cross-run behaviour (engine test) | a second run on a subject inherits the first run's entries and asks nothing about them | `apps/worker/src/engine/tests/multi-repo-research.test.ts:406-860`, `makeCtx` in `apps/worker/src/engine/blocks/support/test-support.ts:154` |

## Out of scope

- Organisation-wide or per-user repository scopes.
- Catalog activation and the bridge state; the map and the scope read the
  catalog as it is.
- Jira smart links and wiki links in answers (still unparsed, bounded at two
  answers).
- Any change to how a pull request trigger chooses its event repository.
- Migrating deployed definition versions: a definition-level pin keeps working
  as the candidate set until a trigger carries a policy of its own.

## Assumptions

- A1. The subject key is the right identity for the record. Two Jira tickets
  are two subjects; a ticket re-entering the AI column is the same subject.
- A2. Defaults by trigger kind, revised after the pre-mortem: a ticket
  `attach` over the enabled catalog, which is today's behaviour; a pull request
  `attach` limited to the catalog relationship neighbours of the event
  repository, which keeps both today's second-repository attach
  (`apps/worker/src/engine/steps/phase.ts:550-565`) and the roadmap promise that
  one repository event may reach approved related repositories
  (`docs/product/roadmap-2026-08-27.md:108`), falling back to the enabled
  catalog rather than to an empty set when the catalog carries no relationships
  or the profile read that holds them fails
  (`repository_discovery_relationships_unreadable`,
  `apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:226`; the
  deterministic builder hardcodes `relationships: []` at
  `apps/worker/src/engine/repository-discovery/catalog.ts:192`), so a
  deployment with no relationships configured keeps today's behaviour; a
  schedule `never` beyond its own
  policy list, because a schedule is configuration and there is nobody awake to
  answer it; a webhook `ask_once` only when the endpoint configures a subject
  path, and `never` otherwise, because without one every delivery is a new
  subject.
- A3. Expiry is decided against the catalog snapshot frozen at run start, and
  only for an entry recorded as `not_enabled` on an activated catalog, so no
  catalog migration and no version counter is needed.
- A4. A person's edit may add any enabled repository; it may not add a
  disabled one and may not bypass the eight repository cap on `selected`
  entries. A person's entry is exempt from the trigger policy filter.
- A5. Prompts, memory documents and trigger output keep the full clarification
  history of the subject as text. Only the repository decision stops reading
  it.
- A6. The repository map is deterministic. Semantic matching by a model is a
  later improvement; the ranking here is relationship first, then lexical.
- A7. The run-start step change ships under a production drain, measured in
  the database as zero `running` and zero `awaiting` agent-workflow rows and an
  empty `active_runs`, which the owner accepts because production is quiet at
  that time of day; the code path tolerates the old output shape.
- A8. `runs.diagnose` gains no new category; a refusal by trigger policy is a
  status reason sentence, like the catalog refusal today.
- A9. Production evidence is four runs on definition 40 and 14: the AIW-402
  reproduction before the change, the same ticket after it, the enable-later
  path, and a vague ticket resolved from the map without a question.
- A10. A trigger policy filters inherited entries as well as new attachments.
  Decided by the advisor rather than asked, because the subject key carries no
  definition and the alternative lets any workflow widen any other workflow on
  the same ticket.
- A11. The record exists only for finite work: a ticket, a pull request, and a
  webhook delivery whose endpoint resolves a subject id. A schedule and a
  subject-less webhook take their repositories from the trigger policy on every
  firing and keep no record, which removes the occurrence key rewriting and the
  race between two occurrences over one row.
- A12. Rejected deliberately: a guard letting a run only OPEN A PULL REQUEST in
  a repository a person, the ticket or the policy named, leaving an `inferred`
  attach read-only. Expansion already opens pull requests in attached
  repositories, narrowing that is a product change nobody asked for, and the
  real hole the pre-mortem found was the approved-plan freeze, closed above.
- A16. The per-kind trigger configuration schemas are `.strict()`, so the
  policy is purely additive and needs no migration: a stored definition without
  it parses exactly as before, and the documented breaking direction is
  REMOVING an optional key, not adding one
  (`apps/worker/src/engine/definition/block-params-schemas.ts:99-103`). The
  trap runs the other way: once a person saves a policy, a worker rolled back
  to before stage 1 rejects that definition outright. Stage 1 therefore ships
  before anything can write a policy, and a rollback past it means clearing the
  field first.
- A14. The trail is the primary record and `workflow_runs.analysis_report` is
  the richer view on top of it, not the other way round, because the report is
  written only after a phase completes and the runs worth debugging are the
  ones that never got there. Nothing is copied into the report.
- A15. Clarification rows keep their prose. The repository a question is about
  is written at ask time, not parsed out of the question afterwards, and
  nothing in the product ever turns a sentence back into a repository key.
- A17. The trigger policy is resolved at RUN START in stage 4, read from the
  deployed graph, not first honoured in stage 6. Otherwise the window between
  the two deploys has inheritance live with no filter, which is the exact thing
  A10 exists to prevent.
- A18. The definition level pin keeps its own control in the flow editor
  (`apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx`)
  and its copy changes to say it is the default a trigger inherits unless that
  trigger sets its own policy.
- A13. A Jira project move changes the ticket key and orphans its scope, so a
  person is asked once more under the new key. Accepted: nothing in the worker
  anchors a ticket to an immutable id
  (`apps/worker/src/services/run-lifecycle/reconcile.ts:660-668`), and the
  failure direction is safe, since a scope is lost rather than applied to the
  wrong work.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | Contract: work scope, trigger policy, map types | trigger policy validation | `packages/contracts/work-scope.ts` (new), `apps/worker/src/engine/definition/block-params-schemas.ts` (ONE shared parameter spread, applied to the eight trigger configurations behind the ten trigger types), `apps/worker/src/engine/definition/block-params-schemas.test.ts`, `apps/worker/src/engine/definition/schema-v2.test.ts`, `CONTEXT.md` | opus | no | yes | no | `pnpm run test:packages:zod4` green for the new contracts; block params tests green with a policy accepted on each of the eight configurations covering all ten trigger types, refused on `trigger_plan_approved`, an unknown key still rejected by `.strict()`, and a stored definition WITHOUT the field parsing exactly as before; `pnpm run typecheck` |
| 2 | Store: migration 0066, entries and trail | work scope store; decision trail append | `apps/worker/drizzle/0066_work_scopes.sql` (the versioned entries per subject, the append-only trail whose row carries a subject, a run or both and never neither, and the record of which repository a clarification asked about), `apps/worker/src/db/schema/work-scopes.ts` (new), `apps/worker/src/db/clarifications-schema.ts` (the asked-repository column only), `apps/worker/src/db/schema.ts` export, `apps/worker/src/db/repositories/work-scope.ts` (new) and test | sonnet | no | yes | no | pglite tests: upsert, read by subject, an append and its entry update landing in ONE data-modifying CTE with no `db.transaction` in the module, TWO runs appending on one subject concurrently both succeeding and merging by origin precedence with no version pin, a person's edit still refused on a stale version, a trail row with no subject readable by run, a read returning entries and trail together; `pnpm run db:generate` produces no diff and the generated `.sql` contains no `$1` |
| 3 | Decision module (pure) | work scope decision; repository map rendering | `apps/worker/src/engine/work-scope/**` (new: decide, reconcile with catalog, map render, tests) | opus | yes | yes | no | tests for every origin precedence pair and for an origin overwriting its own kind, expiry only of `not_enabled` and only on an activated catalog, `unusable` and `excluded` never expiring, each expansion rule applied to an INHERITED entry as well as a new request, the cap refusing a ninth `selected` write while still accepting a ninth `unavailable` one, subject eligibility for all four trigger kinds, a `person` entry surviving a policy filter that removes every other inherited entry, map ranking, the twenty five repository threshold and a request for a key outside the map being allowed; no imports from services or db (`workflow-import-boundary.test.ts` green) |
| 4 | Run integration | run-start freeze; selection from scope; expansion from scope; cross-run engine test | `apps/worker/src/engine/steps/run-start-settings.ts`, `apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts`, `apps/worker/src/engine/steps/phase.ts`, `apps/worker/src/engine/repository-discovery/runner.ts` (integration lines only) and its tests in `apps/worker/src/services/repository-discovery/runner.test.ts` (the source file there is a one line re-export), `apps/worker/src/engine/agent-workflow.ts` (ctx wiring only), `apps/worker/src/services/clarifications/answer-core.ts` (write-through), `apps/worker/src/engine/tests/**` | opus | yes | yes | no | engine test: run 2 inherits run 1's entries and asks nothing; AIW-402 scenario passes; the trigger policy is resolved at run start from the deployed graph and filters inherited entries with `person` exempt; every attach, every refusal and every person answer appends exactly one trail line carrying the repository, the origin and the reason, and a parked run resumed twice still appends it once; a test fails if any append happens in workflow scope rather than inside a step; a `plan_approved` run ignores the subject scope and still refuses expansion; a replayed run-start output without the field takes the whole old path; `step-registration-coverage` and `workflow-import-boundary` green; no step added, removed or reordered (reviewer diffs the file); merge only under a drain proved by a query, zero `running` and zero `awaiting` agent-workflow rows and an empty `active_runs` |
| 5 | Repository map in the agent context | repository map rendering (integration); what the agent was shown | `apps/worker/src/sandbox/context.ts`, `apps/worker/src/engine/repository-discovery/protocol.ts` (prompt text and request-by-key), `apps/worker/src/sandbox/context.test.ts` | opus | yes | yes | no | rendered prompt for a 40 repository catalog stays at 12 map lines and under 1600 characters (the repository has no tokenizer, so the budget is counted in characters); a 20 repository catalog renders whole; a request by a map key attaches; a request for a catalog key the map did not show still attaches; only a key outside the catalog or outside the policy is refused; the map recorded by stage 4 reads back through `work_scope.get` identical to the text that was rendered |
| 6 | Trigger policy in dispatch and the flow editor | trigger policy validation (runtime) | `apps/worker/src/services/dispatch/**`, `apps/worker/src/services/manual-dispatch/resolve.ts`, `apps/worker/src/services/repository-catalog/pins.ts`, `apps/dashboard/components/cockpit/flow-editor/blocks/index.ts:75-86` and the TEN `blocks/trigger_*.tsx` field components (copying the shared group pattern of `blocks/pr-trigger-fields.tsx` and `blocks/shared.tsx`), `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx` (its copy becomes "the default a trigger inherits unless it sets its own"), `docs/architecture/workflow-definition.md` | sonnet | yes | yes | no | dispatch tests: each kind default per A2, including a webhook with and without a subject path and a schedule under both overlap policies writing no record at all, and a pull request whose catalog carries no relationships falling back to the enabled catalog; explicit policy overrides the pin; the pin still applies with no policy; dashboard test renders and saves the field group |
| 7 | Surfaces: API, MCP, ticket screen, run report | MCP parity; run repository report | `apps/worker/src/routes/api/v1/work-scope/**` (new), `apps/worker/src/mcp/tools/work-scope.ts` (new), `apps/worker/src/mcp/tools/runs.ts` (one tool added), `apps/worker/src/mcp/tool-catalog.ts`, `apps/worker/src/mcp/server.ts`, generated contract, `apps/dashboard/app/(cockpit)/ticket/**`, the run detail screen, `apps/dashboard/app/api/work-scope/**` (new) | sonnet | yes | no | yes | `mcp:contract:check` green with the three tools; route tests for read, update, conflict; `runs.repositories` returns the repositories used with their rationale, the rounds, the requests with a verdict each and the map shown, and answers clearly rather than emptily for a run that recorded none; dashboard test: panel lists entries and an edit sends the version |
| 8 | Evidence, docs, roadmap | none (verification) | `changelog/unreleased/*.md`, `docs/product/roadmap-2026-08-27.md`, `docs/index.md`, `docs/qa/**` | sonnet | no | no | no | four production runs per A9 recorded with run ids and first terminal reads; AIW-402, AIW-377 and the roadmap P1 item commented; changelog entries present |

Order: 1, then 2 and 3 in parallel, then 4, then 5 (it edits files stage 4
owns, so it cannot run beside it), then 6 and 7 in parallel (7 needs 2 and 4,
6 needs 1), then 8. Stage 4 merges
only when the database shows zero agent-workflow runs in `running` or
`awaiting` and an empty `active_runs`; `runs.stats` cannot prove it, because
the terminal helper behind it counts a parked run as finished.

## Production evidence plan (A9)

1. Before any merge: dispatch definition 40 on ticket AWP-211, whose previous
   run was answered "none". Expected today: no question, immediate failure
   naming the repository. This is the AIW-402 reproduction.
2. After stage 4 deploys: the same ticket. Expected: no question, the scope
   shows the repository as `unavailable` decided by the person, the run
   continues without it and fails only if the agent cannot plan without it,
   with a reason that names the scope.
3. Enable-later path: a fresh ticket naming a repository disabled in the
   catalog, answered "continue without it"; enable the repository; a second
   run attaches it without a question. The catalog change is reverted after.
4. After stage 5 deploys: a vague ticket (the campaign's T6 shape) resolves
   its repositories from the map without a repository question.
