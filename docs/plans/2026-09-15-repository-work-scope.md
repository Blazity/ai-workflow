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
   visible repository scope per trigger instead of globally", delivered here,
   and AIW-295 ("consistent visible per-workflow scope handled at the
   trigger").
3. **Work scope** (per subject of finite work: a ticket, a pull request, a
   webhook delivery whose endpoint can name its subject): a durable, typed
   record of which repositories this work touches and how each entry was
   decided. Every run on the subject inherits it, every decision made during a
   run writes into it, and a person can read and edit it on the ticket screen
   and through MCP. A repository is asked about at most once per subject, ever,
   with one exception the record cannot remove: two runs already in flight on
   one subject each froze the record before the other's answer existed, so each
   may ask, and whichever person answers last decides (A24).
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
/** Why a question about a repository was raised, recorded at ask time: a
 *  "none" answer means something different for each reason. Not enabled or
 *  unusable are recorded as unavailable, outside policy as excluded,
 *  selection records nothing. */
export const WORK_SCOPE_ASK_REASONS = ["not_enabled", "unusable", "outside_policy", "selection"] as const;
/** Index order IS precedence: index 0 wins. */
export const WORK_SCOPE_ORIGINS = [
  "person", "workflow_owned_branch", "ticket_text", "trigger_policy", "inferred",
] as const;
export const WORK_SCOPE_REFUSAL_REASONS = [
  "outside_catalog", "outside_policy", "excluded", "unavailable", "workspace_cap",
  "request_limit", // more than three repositories requested at once; extras refused without a question
  "rounds_exhausted",
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

/** A repository a question named, and why. 1 to 8 items, unique repositoryKey. */
type WorkScopeAskedRepository = { repositoryKey: RepositoryKey; askedBecause: WorkScopeAskReason };

type WorkScopeQuestionAnswer =
  | { kind: "none" }
  | { kind: "repositories"; repositoryKeys: RepositoryKey[] } // 1 to 8, unique
  | { kind: "unrecognised" };

type WorkScopeTrailEvent =
  | { kind: "entry_written"; entry: WorkScopeEntry; previousState: WorkScopeEntryState | null; clarificationId?: string }
  | { kind: "entry_removed"; entry: WorkScopeEntry; removedBy: WorkScopeActor } // entry is the row as it was before the delete
  | { kind: "question_asked"; clarificationId: string; repositories: WorkScopeAskedRepository[] }
  // A person's answer as the run read it. With question_asked under the same
  // clarification id it gives the full question and answer history of a
  // subject, including answers that wrote no entry.
  | { kind: "question_answered"; clarificationId: string; answer: WorkScopeQuestionAnswer; answeredBy: WorkScopeActor }
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

/** The one shape a caller hands the store for a single write, from a run or
 *  from a person. replacesExpired is valid only on a "selected" entry that
 *  replaces an unavailable / not_enabled entry the catalog has since enabled:
 *  the one case a lower origin may overwrite a higher one. */
type WorkScopeWritePlan = {
  upserts: Array<{ entry: WorkScopeEntry; replacesExpired: boolean }>; // at most 16, one per key
  deletes: Array<{ repositoryKey: RepositoryKey; origin: WorkScopeOrigin }>; // at most 16, compare-and-delete on the origin the writer saw
  trail: WorkScopeTrailEvent[];                                         // at most 32
};
/** workScopeOriginRank(origin) is the index in WORK_SCOPE_ORIGINS. */

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
  holds no entry for it. The answer writes the entry when the answer ARRIVES,
  not when a run gets round to reading it, so the question cannot recur on the
  subject even if the run that asked dies a second later. The one question that
  names no single repository, which of several repositories matching the
  ticket to start from, is asked at most once per subject: never after a person
  selected a repository on it, and never after a person answered it, whatever
  the answer was.
- What an answer records depends on why the repository was asked, which is
  written down when the question is asked. "Continue without it" answered about
  a repository that was not enabled or not usable records it as `unavailable`
  with the person as decider, not as `excluded`: the person could not give it,
  they did not refuse it. Declining a repository the run could have used, which
  was asked only because the trigger policy did not include it, records
  `excluded`: the person could have given it and did not. Leaving out a
  repository from the "which of these" question records nothing, because that
  question never listed the matches. Naming a repository records it `selected`
  by the person, even while it cannot be used. `excluded` is otherwise written
  only by an explicit edit on the ticket screen or through MCP.
- An `unavailable` entry carries the reason it was unavailable and expires
  when that reason is gone: at run start the record is reconciled against the
  catalog snapshot and the repository listing the run froze. A `not_enabled`
  entry expires once the catalog enables the repository, and never while the
  catalog is a bridge (`activated: false`), where every repository answers
  enabled and an expiry would ask the person a second time. An `unusable` entry
  (the catalog holds no default branch for it, so `usable` is false at
  `apps/worker/src/engine/repository-discovery/catalog.ts:193`) expires once the
  repository becomes usable, typically with its first commit, on any catalog.
  An `excluded` entry never expires. An expired entry does not wait for the model
  to ask again: the next run start attaches it when this trigger's policy would
  have attached a request for it, which is what makes "enable it later and the
  next run takes it" a guarantee.
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
  is the whole reason a person may edit at all: a `selected` entry whose origin
  is `person` is never filtered. A person outranks a policy, because the policy
  is a default for machines. A `workflow_owned_branch` entry is not filtered
  either, because dropping it strands that branch's open pull request, which is
  why today's selection already puts it ahead of the pin
  (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:783-799`).
  Everything else inherited is filtered, `ticket_text` included, because what a
  ticket says does not decide what THIS workflow is allowed to touch. The
  definition pin's providers are not a policy but a capability bound: a
  repository of another provider is never attached and never asked about,
  whoever selected it.
- Outside the candidate set the expansion rule decides: `attach` attaches and
  records `inferred`; `ask_once` asks and records the answer, so the subject is
  asked at most once; `never` refuses with the policy named in the reason. A
  person's edit may add any enabled catalog repository regardless of the policy,
  and the entry carries their identity.
- Guard rails already in the expansion protocol stay: the eight repository
  workspace cap, the two expansion rounds, the three per request. An automatic
  attach counts as a round. The cap bounds one run's WORKSPACE, counted on what
  is attached, exactly as today
  (`apps/worker/src/engine/repository-discovery/runner.ts:386-390`); it never
  bounds the record, because a subject can legitimately hold more selections
  than one workspace takes (two workflows on one ticket, a repository disabled
  since) and counting those would refuse a run holding two repositories. What
  changes is who hears about a guard rail: a request over the cap, over the
  round limit, over three at once or repeated is refused back to the model and
  recorded, never turned into a question to a person, because no answer to it
  could be recorded and it would come back on the next run (A22). A panel edit
  that swaps one repository for another is ONE write carrying a version, never
  a remove followed by an add. An edit is never refused for the cap: selecting
  a repository on the ticket screen is exactly how a person gets past a model
  that was refused `workspace_cap`, and the room of every run still bounds the
  workspace.
- **Storage is one row per repository per subject, not a list in one field.**
  A list rewritten whole by each writer loses the other writer's decision when
  two runs on one ticket write at once. With a row per key, the precedence rule
  is enforced by the statement itself: an upsert overwrites an existing row only
  when its origin rank is lower or equal (a person is rank 0, `inferred` rank
  4), or when the plan marks it `replacesExpired`. A separate one-row-per-subject
  version counter moves only when an entry row actually changed, so the
  refusals a run appends on every start never turn a person's open panel into
  a conflict. A trail line saying an entry was written or removed is appended
  only for rows the statement really wrote or removed: the trail never claims a
  change the record did not take.
- Every write is one statement, because production has no interactive
  transactions. A run's write carries no expected version and cannot conflict:
  precedence decides. A person's edit carries the version it read, so a run or
  another person writing in between turns it into a conflict the panel shows,
  never a silently lost update.

### The decision table (stage 3 implements exactly this)

One pure function answers every event against one context. Nothing below reads
a database, a clock or the network; the caller passes all of it in.

```ts
decideWorkScope(context: {
  scope: WorkScope | null;            // null: no record yet, or a subject that carries none
  carriesRecord: boolean;             // ticket, pull request, webhook delivery with a resolved subject id
  catalog: { activated: boolean; enabledKeys: RepositoryKey[]; unusableKeys: RepositoryKey[] | null };
  // unusableKeys null: this path never listed the repositories, so enabled counts
  // as usable and an unavailable/unusable entry does not expire here
  pinnedProviders: VcsProviderKind[] | null; // the definition pin's providers, null when it names none
  pinnedKeys: RepositoryKey[] | null;        // the definition pin's repositories, null when it names none
  policy: TriggerRepositoryPolicy | null;    // resolved; null only for "answered", "edited" and a subject with no record
  eventRelatedKeys: RepositoryKey[];  // related keys of event_repository_and_related, NOT filtered by the catalog
  attachedKeys: RepositoryKey[] | null; // what the workspace holds now; null outside a run
  selectionAnswered: boolean;         // a selection question on the subject was answered none or with repositories
  actor: WorkScopeActor;
  now: string;
}, event:
  | { kind: "run_started" }
  | { kind: "resumed"; repositoryKeys: RepositoryKey[] }
  | { kind: "derived"; origin: "workflow_owned_branch" | "ticket_text" | "trigger_policy" | "inferred"; repositoryKeys: RepositoryKey[]; rationale: string }
  | { kind: "text_ambiguous"; matchedKeys: RepositoryKey[] }
  | { kind: "requested"; repositoryKeys: RepositoryKey[] }
  | { kind: "answered"; clarificationId: string; asked: WorkScopeAskedRepository[]; answer: WorkScopeQuestionAnswer } // read by readRepositoryAnswer
  | { kind: "edited"; changes: WorkScopeEditRequest["changes"] }
): {
  plan: WorkScopeWritePlan;
  attach: RepositoryKey[];
  ask: WorkScopeAskedRepository[];
  refused: Array<{ repositoryKey: RepositoryKey; reason: WorkScopeRefusalReason }>;
  editRejected: Array<{ repositoryKey: RepositoryKey; reason: "not_enabled" }>;
  trailTruncated: number;             // refusals that did not fit the plan's trail, counted so the status reason can say so
}
```

Words used below.

- **Usable**: in `enabledKeys` and not in `unusableKeys`. Where `unusableKeys`
  is null the path never listed the repositories (a pull request run decides
  from the enabled list alone), so every enabled key counts as usable and an
  `unavailable` `unusable` entry does not expire there, since nothing observed
  that it became usable.
- **In the pin**: `pinnedProviders` is null or holds the key's provider prefix,
  AND `pinnedKeys` is null or holds the key. The definition pin is a capability
  bound, like the catalog: `filterPinnedRepositories` strips anything outside it
  from the run anyway (`apps/worker/src/adapters/vcs/repository-directory.ts:177-190`),
  so an entry outside it could never be honoured. A person's selection is not
  exempt from it and nothing outside it is ever asked. The one exemption is
  `workflow_owned_branch`, and it exists because the selection already makes it:
  a run attaches the repository of a branch this workflow owns whether the pin
  names it or not, so that a pull request opened by an earlier run is not
  stranded (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:1068-1078`).
  Without the exemption the decision refuses the very repository the agent is
  working in and the prompt tells it the repository was left out. An abandoned
  pull request costs more than the pin's tightness; this plan said otherwise
  until a skeptic round found the contradiction. The pin names repositories as
  well as providers (`packages/contracts/domain.ts:649-652`), which is why both
  halves bind.
- **Reachable**: usable and in the pin.
- **Candidate**: allowed by the policy's candidate set (`enabled_catalog`: every
  usable key; `event_repository_and_related`: `eventRelatedKeys`; `listed`: the
  listed keys).
- **Exempt origin**: `person` and `workflow_owned_branch`. A `selected` entry of
  either origin passes the candidate set (an `unavailable` or `excluded` entry
  is never a selection, so exemption does not apply to it), because a person outranks a default made for
  machines and a workflow-owned branch must never strand its open pull request
  (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:783-799`).
- **Expired**: an `unavailable` entry whose key is now usable; for reason
  `not_enabled` only on an ACTIVATED catalog, where "enabled" means something.
  An `unusable` entry expires too, because a repository without a default
  branch becomes usable with its first commit and the question's own advice
  would otherwise do nothing. An expired entry behaves as if there were no
  entry, and a `selected` upsert over it sets `replacesExpired`.
- **Blocking entry**: `excluded`, or `unavailable` that is not expired.
- **Allowed**: the key is a candidate, or the expansion is `attach`, or its
  entry is a `selected` entry of exempt origin.
- **Allowed if usable**: what "allowed" would say about the key if the catalog
  held it, that is the candidate set computed IGNORING usability (every key
  under `enabled_catalog`, membership under `listed`, membership in
  `eventRelatedKeys` under `event_repository_and_related`), or the expansion is
  `attach`, or its entry is a `selected` entry of exempt origin. It separates
  the two reasons a key can sit outside the candidate set, and the separation is
  permanent: asked `not_enabled` a declined key is recorded `unavailable` and
  expires the moment the catalog enables it, asked `outside_policy` it is
  recorded `excluded` and never expires. A key the catalog alone keeps out is
  therefore never asked `outside_policy`, or "enable it later and the next run
  takes it" would be a promise this feature cannot keep.
- **Room**: 8 minus `attachedKeys`, minus what this event already attached. The
  cap bounds the WORKSPACE of one run, never the record: a subject may hold more
  `selected` entries than one workspace takes (two workflows on one ticket, a
  repository disabled since), and counting those would refuse a run holding two
  repositories.
- **Order**: keys in input order. `run_started` walks entries by origin rank,
  then key, so a person's entries take the room first.
- **No-op upsert**: an upsert whose state, reason, origin and rationale equal
  the stored entry is not planned, so re-deriving the same ticket text on every
  run writes nothing and appends nothing. The caller therefore builds a derived
  rationale from the evidence only (the matched words, the branch name), never
  from a run id or a time.

Trail: every planned upsert appends one `entry_written` with the previous state,
every planned delete one `entry_removed`, every refusal one `request_refused`,
and every `answered` one `question_answered` carrying the answer as read.
`question_asked` is appended by the caller once the clarification exists, with
the `ask` list and its reasons.

| Event | Situation | Result |
|---|---|---|
| any run event | `carriesRecord` false | the attach and refusal columns as below, no upserts, no deletes, nothing asked |
| any run event | `policy` null | programming error, thrown: the caller resolves the kind default when the trigger node carries no policy, so a null there is a bug that would otherwise start a run with no candidates and look like a decision |
| `run_started` | key already attached | nothing |
| `run_started` | `selected`, reachable, candidate or exempt origin, room | attach |
| `run_started` | `selected`, reachable, candidate or exempt origin, no room | refused `workspace_cap`, entry kept |
| `run_started` | `selected`, not usable | refused `outside_catalog`, entry kept, no question |
| `run_started` | `selected`, usable, not reachable | refused `outside_policy`, entry kept |
| `run_started` | `selected`, reachable, not candidate, origin not exempt | refused `outside_policy`, entry kept |
| `run_started` | expired (either reason), reachable, candidate or expansion `attach`, room | attach; upsert `selected` origin `inferred` with `replacesExpired`, the rationale naming the answer it replaces. The person said "continue without it" because it could not be had; this replays the request that raised the question, which makes "enable it later and the next run takes it" deterministic rather than a hope that the model asks again, and it stays inside this trigger's policy because the person selected nothing |
| `run_started` | any other entry | nothing |
| `resumed` | the listed keys, read against the scope after an answer arrived | exactly the `run_started` rows, for those keys only |
| `derived` | key already attached | nothing, and the key still counts as named by this event for the delete row below, so its own entry is not dropped for being absent. Without this a person's entry attached at run start would collect a `request_refused` `outside_policy` from the text match of the same run, and the trail would refuse a repository the run is using |
| `derived` | key has a blocking entry | refused with `excluded` or `unavailable` |
| `derived` | key not usable | refused `outside_catalog`; a derived key never asks |
| `derived` | key usable, not reachable | refused `outside_policy` |
| `derived` | key reachable and allowed (the event's origin exempt counts, and so does an existing `selected` entry of exempt origin), room | attach; upsert `selected` with the event's origin, which the store keeps only if precedence allows |
| `derived` | as above, no room | refused `workspace_cap`, no entry |
| `derived` | key reachable, not allowed | refused `outside_policy`; a derived key never asks |
| `derived` | origin `ticket_text` or `workflow_owned_branch`, an entry of THAT origin exists for a key not in this event | delete it, comparing on that origin |
| `text_ambiguous` | `carriesRecord`, no `selected` entry of origin `person`, `selectionAnswered` false | drop from the matched keys everything not reachable and everything carrying a blocking entry, then ask the survivors (at most 8, the caller's ranking) with reason `selection`, and only when at least two survive: a repository behind the provider pin may never be offered, one already decided may not be offered as if it were open, and one survivor is not an ambiguity. The caller applies the same filter BEFORE it counts matches, so a set collapsing to one to three decidable keys becomes an ordinary `derived` `ticket_text` event instead of a repository nobody derives and nobody asks about |
| `text_ambiguous` | otherwise | nothing asked; the run starts from what the record holds |
| `derived` | an EMPTY `repositoryKeys` list | the caller saying the evidence is gone, so that origin's entries are deleted. The caller emits it ONLY when the matcher found nothing at all: matches it found but could not decide (ambiguous, behind the pin, already refused) leave the previous entries alone and go in the status reason, or correcting a ticket would empty its scope with nobody asked and nothing said |
| `requested` | more than 3 keys | the first 3 are decided below, first matching row wins; the rest refused `request_limit`, never a question |
| `requested` | key already attached | nothing |
| `requested` | key not in providers | refused `outside_policy`, never a question |
| `requested` | key has a blocking entry | refused with `excluded` or `unavailable`, never a question |
| `requested` | key not usable, allowed if usable, no entry, `carriesRecord`, expansion not `never` | ask with reason `unusable` when enabled, otherwise `not_enabled`: the catalog is the only thing keeping it out, so the answer must be recorded as something that expires when the catalog changes |
| `requested` | key not usable, allowed if usable, otherwise (a `selected` entry included, `never`, or no record) | refused `outside_catalog` |
| `requested` | key not usable, not allowed if usable, expansion `ask_once`, `carriesRecord`, room, and no entry or a `selected` entry of non-exempt origin | ask with reason `outside_policy`: this repository stays outside the policy whether the catalog holds it or not, so declining it is a decision that may last |
| `requested` | key not usable, not allowed if usable, otherwise | refused `outside_policy` |
| `requested` | key usable, not allowed, expansion `ask_once`, `carriesRecord`, room, and no entry or a `selected` entry of non-exempt origin | ask with reason `outside_policy`: a repository outside the policy is asked about ONCE, and an answer naming it records `selected` `person`, which attaches |
| `requested` | key usable, not allowed, otherwise | refused `workspace_cap` when room is the only obstacle, otherwise `outside_policy` |
| `requested` | key usable, allowed, room | attach; upsert `selected` `inferred`, `replacesExpired` over an expired entry |
| `requested` | key usable, allowed, no room | refused `workspace_cap`, no entry, never a question |
| `answered` | `carriesRecord` false | programming error, thrown |
| `answered` | answer `unrecognised` | no entries; `question_answered` only; the protocol asks its follow-up, which carries the same `asked` list |
| `answered` | answer `none` or `repositories`: an asked key the answer does not name | reason `not_enabled`: upsert `unavailable` `not_enabled` `person`; reason `unusable`: upsert `unavailable` `unusable` `person`; reason `outside_policy`: upsert `excluded` `person` (the person could have given it and declined); reason `selection`: nothing (the question never listed the matches, so an omission is not a decision) |
| `answered` | a named key, enabled or not | upsert `selected` `person`. Naming a repository is asking for it, so the entry says selected even while the repository cannot be used: `run_started` keeps refusing it `outside_catalog` without a question, and attaches it, past the candidate set, on the first run after it is enabled |
| `edited` | `carriesRecord` false | programming error, thrown |
| `edited` | the whole edit | the changes are folded per repository first, last change wins, so `remove A` then `select A` plans one upsert and no delete and the reverse plans one delete and no upsert; the result is then decided on the set after EVERY change, and one rejected change rejects the edit and leaves the plan empty. Planning both an upsert and a delete for one key would leave the row's fate to two CTEs reading one snapshot |
| `edited` | `select` | enabled: upsert `selected` `person`; not enabled: rejected `not_enabled` |
| `edited` | `exclude` | upsert `excluded` `person` |
| `edited` | `remove` | delete comparing on the current entry's origin; no entry: nothing |

Bounds. The caller never passes more than 8 derived keys, 8 matched keys, 8
asked keys or 8 named keys (asked keys are read before named ones, so every
asked key is decided), which keeps every plan inside the contract's 16 upserts,
16 deletes and 32 trail events. The one event whose output grows with the
record is `run_started`: its refusals enter the plan's trail in walk order up to
the bound, `refused` still lists them all, and the caller puts the full count in
the status reason, so nothing is dropped without saying so.

**What a change to run start must run before it is believed.** Every engine
test boots a run, and the run start step now reads the record, so a test that
mocks the database handle without mocking `db/repositories/work-scope.js` fails
on the read rather than on anything it meant to prove
(`apps/worker/src/engine/tests/agent-no-enabled-repository.test.ts` and
`agent-retired-replay.test.ts` did). A change to run start is gated on the whole
of `src/engine/tests`, never on a chosen file.

**Where each event is decided, and why `answered` is not decided in a run.**

- `run_started`, `derived`, `text_ambiguous`, `requested` and `resumed` are
  decided in the run and ride the carriers named in "The decision trail".
- Where they are decided follows one fact: `usable` is computed from a provider
  LISTING, not from a table (`apps/worker/src/engine/repository-discovery/catalog.ts:191-193`),
  and the rows a run start can read carry provider, path and enabled only
  (`apps/worker/src/db/repositories/repository-catalog.ts:190-198`). So the run
  start FREEZES the scope, a pure read, and decides nothing; `run_started` is
  decided where the listing exists, which is the pre-sandbox step for every kind
  that has one (`blockPrepareWorkspacePreSandboxStep`, `maxRetries = 0` at
  `apps/worker/src/engine/blocks/prepare-workspace/execute.ts:114`).
- The pull request branch beside it (`:818-823`) READS the record and writes
  nothing, and stage 4 leaves it that way. The branch calls exactly one step,
  `blockPrTriggerRepositoriesWithSiblingsStep`
  (`apps/worker/src/engine/blocks/fetch-pr-context/execute.ts:36`), which
  assigns no `maxRetries` and therefore retries three times, and a retry
  duplicates trail lines: an upsert of an identical row passes
  `overwriteAllowed` on equal origin ranks
  (`apps/worker/src/db/repositories/work-scope.ts:300-308`) and so returns a row
  and appends `entry_written` a second time (`:487-503`). The two ways out are
  both refused. Giving that step `maxRetries = 0` would fail every pull request
  run on one transient read of `findConnectedRunPrSiblings`, a reliability
  regression bought with a debug line. Deduplicating refusals by a unique index
  would erase real ones: the refusal vocabulary has no reason for a repeat
  (`packages/contracts/work-scope.ts:68-78`), so a second request for the same
  repository carries the reason of the first, and an index would collapse a
  looping agent into one line, which is one of the signals this trail exists to
  show. A pull request subject's record can only be non-empty through a panel
  edit (stage 7) or a person's answer, and pull request runs ask about no
  repository, so the read is a no-op today and correct once either exists.
  Writing it belongs to the stage that gives that path a carrier. That stage
  also folds in a duplication this one accepts: the pull request path answers
  "reachable" with its own hand written copy of the pin, the usability test and
  the workspace cap, beside the one in `engine/work-scope/context.ts`. Two
  copies of a rule is a cost worth paying while the path only READS, and a
  defect to keep once it decides.
- What the model may be offered is narrowed in ONE place, where the catalog is
  assembled into the discovery prompt (`offerableRepositoryCatalog`, applied in
  `discoverRepositories`, `apps/worker/src/engine/agent-workflow.ts:1748`), not
  where the catalog is first built in the pre-sandbox. Both the ordinary path
  and the pre-sandbox fallback reach the model through that one function
  (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts` calls
  `options.discoverRepositories`, wired at `agent-workflow.ts:2049` and
  `:2198`), so one filter covers both, and it runs before the prompt exists,
  which is the difference between a repository the model is never offered and
  one it is offered and then refused for. A repository somebody excluded on this
  work is therefore absent rather than declined, and nothing is said about it: a
  refusal sentence naming it would invite the model to argue with a person's
  decision it cannot see.
- The trigger policy is resolved after the deployed graph is loaded
  (`loadWorkflowDefinitionFor`, `apps/worker/src/engine/steps/definition-step.ts:65`,
  `maxRetries = 0` at `:238`, called at `apps/worker/src/engine/agent-workflow.ts:579`),
  not at run start: nothing the run start reads carries the trigger node's
  configuration (`apps/worker/src/engine/agent-input.ts:42-116` holds the
  definition id, and the node id for webhooks and schedules only). A35 says what happens when
  the node cannot be identified.
- `question_asked` is appended where the clarification row is created
  (`prepareClarificationHookStep`, `apps/worker/src/engine/steps/clarification-hook-steps.ts:22`).
  That step retries, so the append is made idempotent by a partial unique index
  on the clarification id, the same shape as the answer index, and it is written
  with ON CONFLICT DO NOTHING. Retry safety by key beats retry safety by luck,
  and it is needed here: the clarification insert itself is not idempotent
  (`apps/worker/src/db/repositories/clarification-hooks.ts:76` generates a new
  id per attempt), so a retried attempt writes a second clarification and a
  second, equally truthful, asked row.
- `answered` is decided ONCE, when the answer ARRIVES, in the one function all
  three answer channels share (`answerClarificationAndResumeWithPersistence`,
  `apps/worker/src/services/clarifications/answer-core.ts:194`; the dashboard
  route, the Jira comment webhook and the MCP tool all reach it). That function
  reads the answer with the same pure reader the protocol uses, loads the
  catalog snapshot the services tier already exposes, applies the plan in ONE
  statement that also inserts the `question_answered` row, and then resumes the
  run exactly as it does today (`answer-core.ts:283`). The reason: a person's
  answer must survive the run that asked it. Runs fail after an answer often,
  and a run that dies between the answer and its next step would otherwise lose
  it, so the next run asks again, which is the defect this plan exists to end.
- Exactly once: `question_answered` is unique per clarification id, and the
  statement applies the entries only when that row was inserted. A retried
  resume of the same answer (`answer-core.ts:205-209`) writes nothing twice.
- The answer is read against the catalog store's keys PLUS the question's
  asked keys, so a person naming back the repository they were asked about is
  always understood, even when the catalog table does not hold it. On a bridge
  catalog a repository that is neither in the table nor asked about cannot be
  named. The `unrecognised` verdict carries no name, so the follow-up says the
  answer matched no repository it can use and re-lists the asked ones with their
  full keys.
- The reader is given the asked keys as well as the catalog keys, and reads in
  this order. An identity token the answer holds (a provider-scoped key or an
  `owner/repo` path) decides it: one that does not resolve makes the answer
  unreadable, and one that resolves inside a sentence that ALSO reads as a
  refusal makes it unreadable too when every key it names was asked about, since
  "none, we don't need acme/api" about the repository we asked about is a
  contradiction rather than a selection. A refusal naming a DIFFERENT repository
  ("not that one, use github:acme/web") selects that one. With no identity token
  the refusal reader decides, then the bare last-segment list, and last: when the
  question asked about exactly ONE repository and the whole answer is an
  affirmative from a short exact-match list (yes, sure, ok, go ahead, do it and
  their kin), the answer is that repository. That last rule exists because the
  common question is about one repository and "yes please" is how a person says
  yes to it; without it the answer is unreadable, and an unreadable answer used
  to end as a permanent refusal in their name.
- An answer nobody can read never becomes a durable decision. A second
  unreadable answer closes the request back to the model, exactly as a refusal
  of the protocol does, and records nothing but the `question_answered` rows
  already written. The subject may therefore be asked once more by a later run,
  which is the right failure direction: nobody said no, and the trail shows both
  unreadable answers to whoever wonders why the question came back.
- **The resumed run reads the RECORD, never the answer text and never a copy of
  it in the resume payload.** In one step that cannot retry it reads the
  subject's scope, its `selectionAnswered` flag, and the verdict of the
  repository question this run had answered (the trail row for its own run id).
  That is everything the answer meant: the entries it wrote, whether the
  selection question is now settled, and whether the answer was unreadable, so
  the run asks its follow-up. Carrying the answer through the resume payload
  instead would mean threading a new shape through the workflow graph package's
  scheduler, invocation context and interpreter, which buys nothing the record
  does not already hold and adds a cross package change to a stage that must
  not move a step. A re-read also sees a panel edit made between the answer and
  the wake, which is the fresher truth rather than a staler one.
- On `already_applied` nothing more is written, and the resumed run reads the
  record anyway, so a retry hours later cannot tell the run something the
  record does not hold. If the record write fails after the answer was
  accepted, the answer function reports an error, and the channel's retry of
  the same answer applies it once and resumes.
- A clarification whose row carries no asked repositories (any question that is
  not about repositories, and a question asked before this ships) writes
  nothing to the record, and the run that resumes on it behaves exactly as it
  does today.
- A person's answer and a person's edit ignore the trigger policy on purpose
  (A10). The three per request bound is in the table. The round limit stays in
  the protocol, and it refuses the model (`rounds_exhausted`) instead of asking
  a person; so do a duplicate request and a request beyond the workspace (A22).

### What stops re-deriving

- Pre-sandbox selection starts from the work scope, and the existing matching
  over the ticket text still runs on every run, because a corrected ticket must
  be able to replace what its old text matched. Up to three matches are a
  `derived` event of origin `ticket_text`; more than three are ambiguous, derive
  nothing (so earlier `ticket_text` entries are deleted) and raise the "which
  of these" question at most once per subject. The label routing memory
  (`apps/worker/src/memory/repo-routing.ts`, learned across tickets and able to
  name a repository the ticket text never mentions) is a `derived` event of
  origin `inferred`.
- The answer to the pre-sandbox question never came from an earlier run: the
  interpreter appends the CURRENT answer as a synthetic trailing comment
  (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts:830-836`) and
  `latestClarificationAnswer` finds that one
  (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:1016-1024`), since
  no Jira comment carries that author. It stops being testimony about
  repositories anyway: the answer was read and recorded when it arrived, and
  the resumed run takes its repositories from the record. The synthetic comment
  stays only because the model's context reads it.
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
  of the research loop, takes everything from the work scope, which holds the
  current run's answer because the answer path wrote it on arrival.

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
- **The map is filtered by the catalog and the definition pin, NEVER by the
  trigger policy's candidate set.** It is the only list of repositories the
  model ever sees, so filtering it by the candidate set would mean the model
  never requests a repository outside the policy, nobody is ever asked about
  one, and `ask_once` becomes a setting that can never fire while the run
  quietly works in the wrong place. A repository outside the candidate set is
  listed with ` (asks first)` at the end of its line, so the model knows the
  request costs a person's attention. Repositories carrying a blocking entry
  are not listed at all, because a request for them is refused without a
  question and listing them only burns a round.
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
  clarification. A refusal that asks nobody rides the next existing step
  with `maxRetries = 0` after the decision (the attach step or the phase start
  step); stage 4 names each one and tests it. A refusal line lost when that
  step's invocation dies is accepted, because a refusal changes no entry; a
  duplicate is not, which is why a retried step may never carry one. The status
  reason names refusals only when the run fails
  (`apps/worker/src/engine/steps/telemetry.ts:93-99`); a successful run's
  refusals live in the trail. Naming a carrier per outcome is required, because the
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
| Selection from scope | the run starts from the scope; text matching runs every run as a `derived` event, more than three matches ask the "which of these" question at most once per subject, and routing memory is `inferred` | `selectRepositoriesFromMetadata`, `apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:745-981` |
| Expansion from scope | an entry answers a request before the catalog is consulted; the human re-read at the top of the research loop reads the scope, not other runs' answers | `applyHumanRepositoryExpansion`, `apps/worker/src/engine/steps/phase.ts:105-164`; `validateRepositoryExpansionRequests`, `runner.ts:277-392` |
| Repository map rendering (pure) | ranked, capped index text from a catalog snapshot, attached keys, ticket terms and the scope | `apps/worker/src/sandbox/context.ts:129-161` (research prompt), `assembleRepositoryDiscoveryPrompt`, `runner.ts:56-97` |
| Trigger policy validation | a trigger node with a policy validates; unknown keys and an expansion rule the kind does not allow are refused | the per-kind `.strict()` config schemas at `apps/worker/src/engine/definition/block-params-schemas.ts:66,131,199,294` and their tests in `block-params-schemas.test.ts:10` |
| Decision trail append, run side | an attach, a refusal or an automatic choice appends one line naming the repository, the origin and the reason, inside the step that already attaches and already writes | `attachResearchRepositoriesStep`, `apps/worker/src/engine/steps/phase.ts:527` with its existing write at `:581`; the actor and reason columns of `repository_profile_versions`, `apps/worker/src/db/repositories/repository-catalog.ts:556` |
| Answer recorded on arrival | an answer to a repository question writes its entries and its `question_answered` row once, in one statement, from the shared answer function, and a retried resume of the same answer writes nothing; the resumed run reads the record rather than any copy of the answer | `answerClarificationAndResumeWithPersistence`, `apps/worker/src/services/clarifications/answer-core.ts:194`, its status guard at `:205-209` and its resume at `:283` |
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
- A3. Expiry is decided against the catalog snapshot and the repository
  listing frozen at run start: `not_enabled` only on an activated catalog,
  `unusable` on any catalog once the repository is usable. No catalog migration
  and no catalog version counter is needed.
- A4. A person's edit may add any enabled repository and may not add a
  disabled one; an answer may name a disabled one, because it answers a run's
  request and the entry waits for the enable. No cap applies to an edit (A28). A
  person's `selected` entry is exempt from the trigger policy filter, never
  from the definition pin's providers.
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
- A9. Production evidence is six runs on definition 40 and 14: the AIW-402
  reproduction before the change, the same ticket twice after it (one question
  the first time, per A23, none the second), the enable-later path (two runs),
  and a vague ticket resolved from the map without a question. Each is judged
  on the trail, not on the run outcome.
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
- A20. The recon of 2026-09-15 reported that the clarification history read
  reaches only prompt text. That is wrong and is the defect itself:
  `applyHumanRepositoryExpansion` takes the LAST answered clarification of the
  whole ticket and applies it as a repository answer
  (`apps/worker/src/engine/steps/phase.ts:139-152`, fed by
  `loadClarificationHistoryStep`, `apps/worker/src/engine/steps/clarification.ts:196-210`,
  which filters by ticket and never by run). Stage 4 restricts that re-apply to
  clarifications asked by the current run; what earlier runs decided reaches a
  later run only through the work scope. Wave 4 rewrote that function without
  closing this, which the third skeptic round proved by walking a second run
  into a failure on a repository nobody had decided anything about; A42 records
  how the correction wave closes it.
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
- A19. The backlog scan of 2026-09-15 named AIW-370, AIW-371 and AIW-376 as
  conflicts. They are not: the workflow graph package, the repository catalog
  with its pins and the `repositories.*` MCP tools are all on `main`, so those
  issues are stale in Jira, not in flight. AIW-284 and AIW-377 were fixed by
  pull request #482 and only await verification. No sequencing follows from
  them.
- A21. The skeptic pre-mortem of the decision table (2026-09-15) raised ten
  findings, each verified in the code before triage. Fixed in the table: a
  "none" to a usable repository expiring at once (asked reasons, `excluded`); a
  named unusable repository recording nothing (named means `selected`); the cap
  counting the record instead of the workspace (room); a remove and a select
  half applying (an edit is decided on its final set); the text matching
  contradiction and story 4 depending on the model asking again (matching runs
  every run, an expired entry is attached at run start); two unreadable answers
  leaving nothing (the follow-up carries the same asked list, and the closure
  is an answered "none"); a provider-only pin no longer bounding the run
  (`pinnedProviders`); the workflow-owned branch losing its exemption. The
  evidence step that could not pass is A23. Rejected with reasons: A24, A25.
- A22. The guard rails of the expansion protocol (the round limit, more than
  three repositories at once, a repeated request, a request over the workspace
  cap) refuse the model and never ask a person. Decided by the advisor: no
  answer to those questions can be recorded against a repository, so each one
  would return on the next run that behaves the same way, which is the promise
  this plan exists to keep. The refusal is in the trail and the status reason,
  and a person can still select a repository on the ticket screen. It also
  removes the path that repeated the round-limit question (AIW-377). The owner
  may reverse it; the price is a question that can be asked twice.
- A23. A ticket whose repository question was answered before this ships has no
  record, and nothing turns the old prose answer into one (A15), so its first
  run after the deploy may ask once more. Accepted: one question, once, per such
  ticket. The alternative, parsing the old question text back into repository
  keys, is how a wrong repository gets recorded against a person's name.
- A24. Rejected (finding 7): a late answer must not overwrite a newer panel
  exclusion. At equal rank the later person decision wins, and an answer naming
  a repository after someone excluded it IS the later decision; the trail keeps
  both, each with its actor. The panel is the version-checked path, so an edit
  racing an answer surfaces as a conflict rather than overwriting it.
- A25. Rejected (second half of finding 10): attaching, at run start, an
  inherited entry outside the candidates when the expansion is `attach`.
  `attach` governs what the model may ADD, not what is loaded before it asks;
  pre-loading everything another workflow once chose clones work this workflow
  may not need. The map ranks those repositories and one request attaches them.
- A26. The answer is decided where it arrives, which has the catalog store
  snapshot but no repository listing, so it cannot tell enabled from usable. A
  named enabled repository without a default branch is recorded `selected` and
  refused `outside_catalog` at run start, without a question, until it becomes
  usable.
- A27. Every answer is recorded as read (`question_answered`), including answers
  that wrote no entry, so `work_scope.get` returns every question with its
  answer, and the "which of these" question can tell it was already answered.
- A28. The second skeptic pre-mortem (2026-09-15) raised ten majors and no
  blocker; every one was verified and fixed rather than deferred, because each
  broke the ask-once promise or the evidence. Refusals now ride steps that
  cannot retry them; the run's context after a resume is defined and read from
  the record; `unusable` expires once usable; an answer is read against the
  asked keys too, a retry writes nothing because the record already holds the
  answer, and a failed record write is retried by the channel; a repository
  outside the policy under `ask_once` is asked about once, whatever its
  availability, and a provider outside the pin never; the edit cap is gone; pull
  request runs read the scope (stage 4 owns their selection step); the evidence
  is judged on the trail. Residual risks accepted: an answer arriving after a
  cancel retired its question is refused and the next run asks; a panel
  exclusion made between an answer and the resumed run's wake still attaches in
  that run; eight `person` entries can take the whole room before a
  workflow-owned branch; a pull request and its ticket are two subjects (A1).
- A36. A webhook delivery carries a resolved subject exactly when its subject
  key is not the delivery-id fallback, which a run tests itself from
  `entry.endpointId` and `entry.deliveryId`
  (`apps/worker/src/services/webhook-trigger/dispatch-webhook-trigger.ts:155-158`
  builds one or the other). Accepted rather than adding a flag to the run input,
  which would be absent on every run serialized before it existed.
- A32. A repository a person declined because the trigger policy did not hold
  it stays `excluded` after an admin widens that policy. The decision was a
  person's and outranks a machine default, so it is not expired; instead every
  refusal `excluded` names who declined it and when, in the refusal to the model
  and in the run's status reason, and the ticket panel removes it in one click.
  Accepted: a widened policy does not reach back into tickets somebody already
  answered about, and the way back is visible rather than automatic.
- A33. Answering "none" to the which-of-these question silences that question on
  the subject forever, on every workflow. Accepted, with the run's status reason
  naming that answer as the reason its scope is empty, because the ordinary way
  out is the one people already take: name the repository in the ticket, where
  the text match picks it up, or select it in the panel. Rejected alternative:
  expiring the answer when the ticket text changes, which means storing a hash
  of the text and re-asking people who fixed a typo. One correction to this
  assumption as first written: the phrase the reader actually understands is
  "none", alone or followed by punctuation and prose
  (`NONE_WITH_PROSE`, `apps/worker/src/engine/repository-discovery/runner.ts:906`),
  and the set of whole phrases beside it
  (`REFUSAL_ANSWERS`, `:888-897`) does not hold "none of these". So the phrase
  this plan used for the answer is one the reader files as unrecognised, which
  by A34 records nothing and asks the person a second time. Two things follow,
  both owned by later stages: the question copy says "none" and never offers a
  phrase the reader cannot read, and the reader learns "none of these" and
  "none of them", because people type them whatever the copy says.
- A34. An answer nobody could read leaves no entry, so a later run may ask
  once more. Accepted deliberately over the alternative this plan started with
  (closing the second unreadable answer as "none"), because that wrote a
  permanent refusal in the name of a person who may well have been saying yes.
  A repeated question is a cost; a fabricated decision is a defect.
- A35. Which trigger node started a run is carried for webhooks and schedules
  (`apps/worker/src/engine/agent-input.ts:91-93` and `:112-115`), and for
  neither ticket nor pull request runs. Stage 4 resolves the policy from
  the node id when it has one, otherwise from the only trigger node of that kind
  in the deployed graph, otherwise from the shared policy when every node of
  that kind carries the same one, and otherwise from the kind default. Stage 6
  narrows the gap by recording the matched node on dispatch. Accepted: a
  definition holding two triggers of one kind with different policies falls back
  to its kind default until then, which is today's behaviour rather than a new
  narrowing.
- A37. A carrier with `maxRetries = 0` makes a trail line at most once per
  step FAILURE, not once per run. An invocation killed after the write but
  before its result reaches the journal is replayed, and the step runs again:
  the entries converge, because an upsert of the same values is idempotent, and
  the trail can carry the line twice. Accepted for stage 4 rather than paid for
  with a read before every write, which would cost a round trip on every run to
  make a debug line exact. What the zero-retry carrier buys is the common case,
  a step that throws; the rare case is a duplicated line in an artifact nobody
  decides from.
- A40. `run_started` does not attach an entry whose origin is `inferred`. Such
  an entry is recorded and shown, because a person asking why a run took a
  repository deserves the answer, but it never seeds a later run's workspace. An
  inference is true of the run that drew it, not of the subject: "the only
  repository this run could reach" was recorded when the catalog held one
  repository, and it would otherwise be attached first on every run after twenty
  were imported, carrying a rationale that is no longer true. Nothing is lost by
  this, because both signals that produce it, the only-accessible shortcut and
  the label routing memory, are re-derived on every run.
- A39. A failed record write is swallowed in a run and reported by the answer
  path, and the difference is the point. In a run the write is a summary of what
  the run computed from inputs that are all still there (the same ticket, the
  same policy, the same catalog), so the next run start computes it again and a
  lost write costs a line in the debug view; failing the run instead would trade
  a working run for an audit line. On the answer path the write is the only copy
  of a decision a living person made, which nobody will type again because the
  question is closed, so a swallowed write there is the defect this feature
  exists to end. Both log with the subject key and the run id, so the quiet one
  is still findable.
- A38. A decision the record takes from a misread answer cannot be undone by
  the person who wrote it until the panel ships in stage 7: the question that
  produced it is answered and will not be asked again, and
  `applyEditWorkScopePlan` has no caller outside the store. A28 and A30 both
  justified an accepted misreading by "their next answer or one panel click
  undoes it", and until stage 7 neither exists. So the reader is the only guard
  there is, which is why every ambiguity resolves to `unrecognised` and why the
  reader hardening wave exists: a repeated question costs a person a minute, a
  fabricated permanent decision costs them a repository they said no to, in
  every run from now on.
- A47. A subject is ASKED once and TOLD afterwards. The fourth skeptic round
  proved that a person who answers "none" to a discovery question about a
  repository they excluded is asked the same question again after every answer:
  `selection` writes no entry by design, the direct answer text is ignored while
  a record is live (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts`,
  both `input.directAnswer && !record` branches), so nothing the run can read
  changes, the selection comes out empty, discovery runs again, the model names
  the same repository out of the ticket text again, and the same sentence is
  posted again. Each turn costs a planning agent, a ticket comment and two
  transitions, and only the person giving up ends it.
  The record already knows this happened: `selectionAnswered` is true once a
  selection question on the subject has been answered, and `readRunWorkScope`
  reads it. So the discovery path asks only while that flag is false. Once it is
  true, a proposal naming a repository the record decided is DROPPED and said
  out loud instead, through the same note that already reaches a person when the
  which-of-these question is silenced ("The ticket also names X, and this run
  kept to the repositories already chosen on this work"). Telling beats asking
  the second time, because the first answer already settled it and the model is
  the only party still insisting.
  When dropping leaves the proposal empty the run has nothing to work on, and
  then it fails transparently with a sentence naming the repository and who
  excluded it, rather than raising a question whose only answers are one that
  destroys the person's own decision and one that changes nothing. A45 says why
  the second answer cannot be read here at all.
- A48. A duplicate in the model's proposal is the model's protocol error, and a
  person cannot usefully answer it. Today it raises a clarification, which both
  hides anything else wrong with that proposal behind a generic question and
  produces an answer the record drops, because such a clarification names no
  repository. The run de-duplicates and carries on. Nothing is lost: the second
  mention adds no repository, and the refusals that matter are then reached and
  said in the proposal's own order.
- A49. Our own words come out of a person's reply before every rule that can
  ATTACH or ask, and before none of the two rules that can REFUSE. That
  asymmetry is deliberate, and this records why, because it reads like an
  oversight and the next person to find it will want to close it.
  `saysNothingToAttach` and the whole-answer half of `saysNo`
  (`apps/worker/src/engine/work-scope/answer.ts`) keep reading the raw reply, so
  a person who quotes our question and writes "no" underneath is asked once
  more, while a bare "no" settles it.
  What tips it is what a refusal actually writes. Leaving an asked repository
  out of an answer is itself a decision, and `decideAnswered`
  (`apps/worker/src/engine/work-scope/decide.ts`) writes it against that
  person's name: `unavailable` for `not_enabled` and `unusable`, `excluded` for
  `outside_policy`, and nothing for `selection`. A wrong yes hands the run a
  repository it can use and somebody notices. A wrong no writes an entry that
  refuses the repository to every later run, with that person's name on the
  refusal, and nothing can undo it until the panel ships.
  The case that decides it is not the tidy one. A channel numbers several
  questions into one comment, a person quotes the whole comment and writes one
  "no" under it, and a reader working from the remainder would write a refusal
  for every repository in the ask off a word that may have been aimed at one.
  The same exposure exists for a bare "no" to a multi-repository ask, which is
  an argument for tightening that form later, never for widening this one now.
  The cost is bounded and is the cheap kind: one more round, and the person's
  next reply settles it. It is bounded twice over, by `rounds_exhausted` and by
  A47, which turns the second encounter into a statement rather than a question.
  What is genuinely missing is a signal: today the re-ask repeats the first
  question word for word, so a person who quotes gets the same question back and
  has no way to learn that the quote is what made it unreadable. The re-ask has
  to say what we could not read. That is copy, not semantics, and it belongs
  with the per-reason question copy in stage 5.
- A50. A person's answer on the ticket channel is not one person's answer. The
  resume path takes EVERY non-bot comment posted after the question was asked,
  with no filter for intent, composes them as `Author: body` and attributes the
  result to whoever commented last
  (`apps/worker/src/services/clarifications/resume-from-comments.ts`, the
  `qualifying` filter and the composition below it). A colleague's unrelated
  remark on the ticket therefore reaches the reader as part of the answer, and
  `withoutComposedAuthors` strips the author prefixes before the reader sees it,
  so nothing downstream can tell the two apart.
  This is not new and it is not a defect of this feature. What this feature
  changes is the consequence. Before the record, a misread composed comment
  spent one run. Now it writes entries that outlive every run, in the name of a
  person who answered nothing, and it writes two of them at once: the repository
  the stray comment happened to name is recorded `selected`, and the repository
  we actually asked about is recorded `unavailable` or `excluded` for not having
  been named.
  So the record amplifies it, and the record has to carry the guard. The guard
  is not in the composition and not in the reader: it is at the write. When the
  raw answer carries more than one author, the run resumes exactly as it does
  today and NOTHING is written to the record, so the next run asks again. That
  is a cost in the one case where the alternative is a fabricated decision
  attributed to the wrong person. It lands in `services/clarifications`, which is
  its own slice, and it is a precondition of the stage 4 merge, not of any wave
  inside it.
- Deferred with reasons, each a repeated question rather than a fabricated
  decision, and each its own issue rather than a widening of the slice that
  found it. A link to a github.com or gitlab.com repository the catalog does not
  hold takes the WHOLE answer down with it, against the stated intent of the
  comment above `isForeignLink`, so one pasted link makes an otherwise readable
  answer unreadable. A reply of bare names tolerates no prose at all, in either
  language, so "api, web" is read and "api and web", "only web" and "tylko web"
  are not, while a full path survives any amount of prose around it. A question
  asking about two repositories has no readable affirmative, which is correct,
  but nothing takes its place. The ticket channel resolves an answer to the
  NEWEST question on the ticket rather than the one it replied to, which is
  reachable only if a pull request subject run and a ticket subject run are both
  parked on one ticket, and that was not proved. The record write runs before the
  hook resumes and is deliberately not caught, so a transient failure there shows
  the dashboard a 500 on an answer that did commit; the cron's retry heals it.
  All five funnel into the same missing signal A49 names: the re-ask is the
  question, verbatim, so a person repeats the reply that failed until the rounds
  run out.
- A51. The refusal vocabulary reads contrastive CONSTRUCTIONS, and it cannot read
  semantic negation. "use acme/web instead of acme/api" is now correct, and so
  are the other seven phrasings the skeptic found, because each carries an
  explicit operator: instead, rather, drop, ignore, forget, except, out of
  scope, and their Polish kin. "acme/api belongs to another team, acme/web
  please" is still read as selecting BOTH, because after the keys are taken out
  the prose is "belongs to another team please" and there is no operator in it.
  That one is not closed and is not going to be closed by another word. Every
  word added past this point is a guess about phrasing, the list grows without a
  bound anyone can state, and a list long enough to catch semantic negation
  would start reading ordinary sentences as refusals. What closes the class is
  the stage 5 copy telling a person the two forms their answer may take, and the
  panel that makes any wrongly recorded entry undoable. Until then it is a
  recorded residual with its own issue, not a wave's unfinished business.
  This is also where the brief was at fault rather than the executor: it
  demanded that all eight phrasings land correctly AND that nothing beyond the
  listed words be added, which cannot both hold. The executor implemented what
  was prescribed and deliberately wrote no test for the row it could not fix,
  rather than encoding a fabricated decision as expected behaviour. That is the
  behaviour to keep asking for.
- A46. The question asked when the planning agent proposes repositories it is
  not confident about carries those proposals as a `selection` ask, and carries
  only the ones that resolve to a key in the catalog the model was offered.
  It names them in its text today and carries none of them as data, so the
  answer is dropped and the next run asks again: the same defect A41 describes,
  on the last question of the discovery path that still had it. `selection` is
  right in both directions, which is why it is chosen over any other reason:
  "none" writes no entry, so a person who says none silences nothing
  permanently, and naming one or more writes `selected` `person`, which is
  their decision and survives every later run. A proposal the catalog does not
  hold, or that does not parse as a key, is not carried, because the contract
  requires every asked repository to be a real key and a key invented from a
  model's typo would record a decision about a repository nobody has.
  When NOTHING in a proposal resolves, the question carries nothing and its
  answer is still dropped. That residual stays: `workScopeAskedRepositoriesSchema`
  requires at least one repository, so "a repository question about no named
  repository" is not expressible, and the alternatives are a contract change or
  a marker column. Both belong to the stage that also ships the panel where a
  person can undo a decision, because that is the stage where a wrongly
  recorded answer stops being permanent. Until then the cost is bounded to a
  proposal in which the model named nothing real, and it is a repeated
  question, not a fabricated decision.
- A45. On a run that carries a record, the record reader is the ONLY reader of
  a repository answer. Today the in-run parser is a fallback: the resumed
  expansion takes the record's repositories when there are any and otherwise
  re-parses the answer text itself
  (`apps/worker/src/engine/steps/phase.ts:254`). The comment there says the
  record outranks the answer text, and it does, but only when the record has
  something to hand back. Every ambiguity the record reader resolves to
  `unrecognised` on purpose (A34) arrives at that line with nothing, and falls
  through to the older, weaker parser, which is the reader the record exists to
  overrule. The third skeptic round proved the cost: a person refuses a
  repository in words the record reader correctly declines to read, the in-run
  parser reads our own quoted question back as their choice, and the run clones
  it. The record meanwhile holds nothing, because the human attach path calls
  `attachResearchRepositoriesStep` without the optional `workScopeWrite`
  (`apps/worker/src/engine/agent-workflow.ts:2339-2350`), so the workspace and
  the record disagree permanently and nobody can see it.
  Two repairs were available and only one of them is honest. Recording what the
  fallback attached would make the record agree with the workspace by writing
  down a reading its own reader refused to make. Deferring to the reader
  removes the disagreement instead: when the record read the answer and
  recorded nothing, the run does not attach, it asks again, bounded by the two
  unreadable answers that already close expansion. A dumber parser succeeding
  where the careful one refused is not a rescue, it is the careful one being
  overruled by the thing it was built to replace. A run that froze no record
  keeps the fallback unchanged, because there no better reader exists.
- A41. Every question about repositories is raised through ONE place that
  carries what it asks about. The third skeptic round (2026-09-16) found the
  rule held where the brief named it, the model's expansion ask
  (`apps/worker/src/engine/agent-workflow.ts:1949`), and failed at the two
  places it did not: the follow-up raised after an answer this run's parser
  could not read (`:2271`) and the in-run discovery question (`:1818`). Both
  park a person on a clarification whose `askedRepositories` is null, and the
  answer path returns without writing anything when that field is empty
  (`apps/worker/src/services/clarifications/answer-core.ts:449-450`), so the
  person's second answer is dropped and the next run asks them the same thing.
  A rule that has to be remembered at each call site is a rule that will be
  missed at the next one, so the fix is structural: a repository question that
  cannot name what it asks about may not be raised at all.
- A42. The human expansion re-apply is restricted to a clarification THIS run
  asked, which is what A20 assigned to this stage and what wave 4 did not do.
  `ctx.clarifications` comes from `loadClarificationHistoryStep`, which reads
  every answered clarification of the ticket
  (`apps/worker/src/db/repositories/clarifications.ts:105-120`), and
  `applyHumanRepositoryExpansion` applies `rounds.at(-1)`
  (`apps/worker/src/engine/steps/phase.ts:161-162`), so a previous run's "none"
  closes expansion in a later run before the model has said a word, and the
  first repository that run genuinely needs fails it. That is the production
  defect this feature exists to end, reached through the history instead of
  through the ticket text. The full history still reaches the PROMPT, where it
  belongs; only the re-apply narrows. A round carrying no run id is not
  re-applied: it can only come from a journal written before this change, and
  the stage merges under a drain, so the conservative choice costs a question
  that cannot happen rather than applying an answer from a run nobody can name.
- A43. The record a resumed step re-read replaces the run's frozen copy for the
  rounds that follow. Freezing at run start is right for what OTHER people and
  runs do, and wrong for what this run's own question just produced: with the
  frozen copy standing, the same person is asked about the same repository
  twice in one run, and a repository they excluded a minute earlier is refused
  later with nobody's name on it, precisely where the who and the when are most
  knowable.
- A44. A repository the record excluded is refused to the MODEL wherever a
  refusal can reach the model, and told truthfully to a person where it cannot.
  In the EXPANSION the model gets a sentence and another turn, so the refusal
  goes there and no person is troubled. DISCOVERY has no such turn: the agent
  runs once and its proposal is final
  (`apps/worker/src/engine/agent-workflow.ts:1782-1803`), so the only audiences
  left are a person or nobody. Removing the repository from the catalog the
  model is offered (`offerableRepositoryCatalog`) keeps it from being selected
  silently, which is the half that works: the validator receives the filtered
  list, so an excluded key resolves to nothing and cannot be attached. What
  fails is the sentence. The model names it out of the ticket text anyway, and
  the validator parks a person on "Enable it on the Repositories page"
  (`apps/worker/src/engine/repository-discovery/protocol.ts:116-121`), which is
  false: the repository is enabled and usable, and a person excluded it. The
  person is told to do something that changes nothing, and the only recovery
  the sentence offers, naming it again, overwrites their own earlier decision
  without saying so. So that question stays, and it tells the truth: who
  excluded it, that the agent asked for it anyway, and that naming it again
  means taking it back. A question a person can act on beats a silence that
  leaves the model insisting on something nobody will explain, and carrying the
  repository on the question is what makes the answer settle it for good. For
  the same reason the recorder plans an entry only for what
  the verdict actually carries: a request mixing an attachable repository with
  an unknown one returns a question and drops the attachable one
  (`repository-discovery/runner.ts:521-530`), and recording that dropped
  repository as `selected` would make the record say this work touches
  something the run never cloned.
- A30. Two readings of an answer that both names a repository and says no
  ("none, use github:acme/api"). We take the named repository, matching the
  expansion reader already in production, and accept that a person who meant
  "none" gets a repository attached for this run, which their next answer or one
  panel click undoes. The other reading writes `unavailable` or `excluded`
  entries for every asked key, and those outlive the run and silence the
  question forever, so the two mistakes do not cost the same.
- A31. Asking about a repository the catalog does not hold is worth it even
  when the trigger policy would also have kept it out, as long as the policy
  would have taken it once the catalog did ("allowed if usable"). A person who
  answers "continue without it" there gets `unavailable`, not `excluded`, so
  enabling the repository later attaches it with no second question. That
  sentence is the one from the incident, and the reader did not understand it
  until the reader hardening wave taught it the phrase: A33 records the same
  class of error for "none of these". Accepted
  cost: under `ask_once` the person may be asked about a repository that turns
  out to be unusable anyway, which is one question, not a permanent record.
- A29. A repository asked about because the trigger policy did not include it
  is asked for the ticket, not for the workflow: the question says that
  declining keeps it out of this ticket, because the record carries no
  definition (A10) and a decline recorded silently per ticket would surprise the
  next workflow on it.
- A13. A Jira project move changes the ticket key and orphans its scope, so a
  person is asked once more under the new key. Accepted: nothing in the worker
  anchors a ticket to an immutable id
  (`apps/worker/src/services/run-lifecycle/reconcile.ts:660-668`), and the
  failure direction is safe, since a scope is lost rather than applied to the
  wrong work.

### Residuals carried out of stage 4, decided rather than discovered

Each of these was found by a skeptic pass or disclosed by an executor, verified
by the advisor, and left open on purpose. None is a regression of stage 4; each
is written here so the next wave inherits the reasoning instead of rediscovering
the symptom.

- A52. A run left with nothing to work on because the record excluded what the
  model proposed reports `category: "configuration"`. That category promises an
  operator a setting to edit, and here the repository is enabled and usable:
  one person excluded it on one ticket, and the screen that would let anybody
  reverse that ships in stage 7. `provider` was plainly false, so the category
  is the least wrong member of a vocabulary with no right one. Widening
  `ExecutionErrorCategory` is a contract change and belongs to the stage that
  opens the contract anyway. Until then the sentence carries the truth: it names
  the repository and who excluded it.
- A53. The decision table writes `excluded` `person` for every `outside_policy`
  key an answer failed to name, so silence is read as a refusal. Stage 4 closed
  the worst amplifier of this (an answer composed from several authors now
  writes nothing at all), but a single author who answers about one repository
  and says nothing about a second still excludes the second by omission. The
  closure is the question copy of stage 5, which has to name what silence means,
  plus the panel of stage 7.
- A54. The retry that re-delivers a stored composed answer recounts its authors
  from the comments as they stand at retry time, not as they stood at commit
  time. A comment added in between raises the count and declines, which is the
  safe direction. A comment DELETED in between can lower two to one and record
  an answer the guard exists to stop. Closing that needs the count stored beside
  the answered row, which is a column and a migration, so it rides with the
  stage that migrates for the panel.
- A55. A guarded answer writes its `question_answered` trail row with
  `answer.kind = "unrecognised"`, which is untrue: the answer was readable and
  we declined to attribute it. The row stays, because an empty trail would leave
  nobody able to explain a repeated question, and that explanation is the whole
  point of the trail. The vocabulary now carries `unattributed` for exactly that
  (`packages/contracts/work-scope.ts:293`), and the decision table takes no
  decision from either kind (`apps/worker/src/engine/work-scope/decide.ts:741`).
  Rows written before that shipped still say `unrecognised`, and nothing
  rewrites them, so a reader of an old trail still has to know it covered both.
- A56. The gesture that commits an answer on the ticket channel is not carried
  with the answer. `resumeClarificationFromComments` receives the ticket and
  re-reads its comments; it cannot tell "somebody moved the ticket back into the
  column" from "somebody commented", and cannot tell who performed the move from
  who wrote the text. The Jira webhook one level up holds all three facts, the
  event kind, the status change and the actor's account id
  (`apps/worker/src/services/triggers/jira/handle-jira-webhook.ts:110-114`), and
  uses the actor only to suppress our own moves before dropping it. Until those
  travel, a colleague's lone comment plus an owner's column move is one author
  and records in the colleague's name. Threading them is the next wave, and the
  rule it implements is that an answer committed by somebody who wrote none of
  its words records nothing.

- A57. An answer that arrives after the question is no longer open is lost
  whole, and that is the decision rather than the gap. The final red team walked
  it and the chain holds: the only comment ingress reads
  `getResumableClarificationForTicket`, which matches `pending` or `answered`
  rows whose run still holds a `bound` claim
  (`apps/worker/src/db/repositories/clarification-hooks.ts:143-145`), the
  by-id paths refuse a row that is not `pending`
  (`apps/worker/src/services/clarifications/answer-core.ts:282-285`), and
  `recordRepositoryAnswer` has exactly one production call site behind that
  gate. So a reply typed after a cancel, an expiry, or a later round writes no
  entry, no trail row and no comment, and the next run asks again. Recording it
  anyway is the change we are NOT making. What would justify the write is
  somebody holding the question open; all that is left in this case is a comment
  inside a time window, and a window signs decisions that nobody made. That is
  the one failure A34 puts below being asked twice, and the same evidence rule
  already governs a bare "no" on the ticket channel. The person is not left dark
  either way: the run that stopped posts why it stopped, the run that finished
  posts what it finished without (C10), and both now carry a way back that names
  the lever. The row is A14b on the behaviour map. What would change the answer
  is a thread from a comment to the question it replies to, which Jira does not
  give us today and which A56 also waits on.

## Architecture findings and their disposition

A depth audit on 2026-09-16 traced one fact end to end: a person names a
repository and the run works on it. It passes through about eleven modules and
SEVEN of them decide its meaning rather than carry it. That is the structural
reason this stage produced a blocker in every gate round: a guard stood in one
place and the run reached the same conclusion by another. Each duplication below
has a disposition, per merge condition 7.

- **The facts about a key are read in three places.** `decide.ts:189-279`
  (authoritative), `context.ts:154-163` (a hand copy, admitted in its own
  comment), `protocol.ts:412-416` (partial, with an extra condition). DISPOSITION:
  consolidate the `decide.ts` and `context.ts` half into one pure module before
  merge. It is pure to pure, moves no `"use step"`, needs no migration and carries
  no drain implication, and it is covered by two existing test files. The
  `protocol.ts` and `repo-selection.ts` half waits until after merge, because
  `protocol.ts` renders every user-facing sentence about somebody's exclusion and
  is the worst file to resolve a conflict in days before a merge.
- **Origin precedence is declared once and then persisted, which is the real
  hazard.** An earlier revision of this section claimed the ladder was encoded
  twice, in TypeScript and again in SQL. That was wrong, and the correction
  matters. `packages/contracts/work-scope.ts:57` declares the order once;
  `db/schema/work-scopes.ts:57` stores the rank it produces as an `origin_rank`
  column, written at insert time (`db/repositories/work-scope.ts:329`); and the
  whole SQL rule (`overwriteAllowed`, `work-scope.ts:373`) is a numeric
  comparison of that stored column. So SQL never re-derives the order and the
  two copies cannot disagree. Two other things can, and neither is typechecked:
  reordering the array, or inserting an origin anywhere but the end, leaves every
  row already written carrying a rank from the old order, and `overwriteAllowed`
  then compares old ranks against new ones and silently inverts precedence for
  existing subjects; and `db/schema/work-scopes.ts:82` caps the rank `between 0
  and 4`, so a sixth origin compiles, passes every test, and fails at the first
  production write. DISPOSITION: a guard on both. Pin the array's exact contents
  and order with a failure message naming the migration such a change needs, tie
  the constraint's upper bound to the array length, and prove against the test
  database that the constraint actually refuses an out-of-range rank.
- **"Has this been answered" is computed in five places.** Two SQL reads, which
  cannot move; `protocol.ts:405-417`, whose blocking half collapses and whose
  trail half does not; and `decide.ts:605-609` plus `repo-selection.ts:1283-1288`,
  which are the same question in two shapes and do merge. DISPOSITION: two merge
  into the facts module, one moves halfway, two stay. Recorded so the next reader
  does not expect a clean sweep.
- **Two readers of a person's answer with different ambiguity semantics.**
  `work-scope/answer.ts:264` collapses ambiguous and unknown; `runner.ts:1376`
  distinguishes them and raises a scoping question. DISPOSITION: after merge,
  drop the second reader for record-carrying runs. It touches the one
  `maxRetries = 0` step whose journal shape gates the drain, so it is the right
  change at the wrong time.
- **Two refusal renderers.** `context.ts:266-283` and `runner.ts:733-756`.
  DISPOSITION: REVISED by the owner on 2026-09-16, and the revision is right. The
  first reading was that the two wordings differ on purpose, one addressing the
  model and one addressing a person, so merging them would trade a real
  distinction for a thin saving. That defends the wrong thing. Both sites compose
  prose from scratch, so they can drift on FACTS, not merely on phrasing: the
  model can be told a repository was excluded while the person is told it was
  unavailable, and nothing catches it, because there is no shared value to
  compare. A model reading one story and a person reading another is exactly how
  an agent ends up acting on something nobody said.
  So: the refusal becomes ONE typed, validated structure carrying the reason, the
  repository, and who decided and when, and both texts are RENDERED from it. Two
  renderers stay, because the audiences differ; what stops is two independent
  authorings of the same fact. The structure is the source of truth, the prose is
  a view of it, and the type system is what keeps them in step.
- **A convention read two ways.** `unusableKeys: null` means "this path never
  listed repositories", and `answer-core.ts:786-790` and `phase.ts:877-883`
  answer it differently. DISPOSITION: verify before merge whether the difference
  is deliberate, and if it is, say so in the type's own comment.
- **The record is write-mostly.** `applyPersonWorkScopeEdit`, `listWorkScopeTrail`,
  `readWorkScopeAnsweredQuestion`, `decideEdited` and `renderRepositoryMap` have
  no production caller. DISPOSITION: the edit and read surface is now merge
  condition 3, which wires the first four. `renderRepositoryMap` waits for stage 5.

## Merge conditions for stage 4

The owner set the standard on 2026-09-16: this feature is judged on quality, it
has to work in reality, and it has to be clean. That is not checkable as
written, so it is written here as conditions that are. Stage 4 merges when ALL
of them hold, and none of them is waived by a deadline.

1. **No decision is recorded that a person did not make.** Every write of an
   entry traces to something a person was shown. A question that never put a
   repository's name in front of somebody can neither suppress a later question
   nor end a run.
2. **No run dies or hangs for our reasons.** Our own bookkeeping failing, a
   ticket read failing, an identity lookup failing: none of these may consume a
   person's answer, cancel their run, or park it forever.
3. **A person can undo what a person decided.** The record is editable through a
   real surface (an authenticated route and an MCP tool, per the parity rule),
   and a person naming a repository outranks their own earlier exclusion. Until
   both hold, the feature can brick a ticket, and "open a new ticket" is not a
   recovery path.
4. **A skeptic pass finds zero blockers.** Every gate round of this stage so far
   has produced at least one, including two that a reviewer had already
   approved. The first clean skeptic pass is the signal, and a round with
   findings is not closed by arguing them away.
5. **The full gate is green on a frozen tree, run by the advisor.** Not reported
   by an executor, not run while another lane is writing. `pnpm -w run
   verify:changed -- --base origin/main --worktree`, exit 0.
6. **A branch-wide two-axis review**, fixed point at the merge base with main.
   This is the only pass that can see what a per-stage gate cannot: one logical
   change scattered across files, and one module changed for several unrelated
   reasons.
7. **One decision is made in one place.** Where the same fact is decided in two
   modules, either it is consolidated or the duplication is recorded with the
   reason it is deliberate.
8. **The document and the code agree.** Every claim in the feature write-up is
   either true of the code or explicitly marked as a later stage.
9. **A drain measured from the database, for runs in flight only.** An earlier
   revision of this condition also required draining runs parked in a
   clarification, because stage 4 adds a step call (`readWorkScopeAfterAnswerStep`)
   inside the parked clarification path. That is no longer required, and the
   reason is worth keeping because it is the pattern to reuse. The new call is
   guarded by `if (workScopeAsk && ctx.workScope)` (`agent-workflow.ts:1528`);
   `ctx.workScope` is set from `runStartWorkScope`, which returns null for a
   run-start result stored before the field existed (`run-start-settings.ts:215`),
   and the call site omits the key when null. So a run suspended before this
   ships replays its old run-start result, reads no record, and skips the new
   step entirely: its journal never diverges. The branch was swept for
   step-bearing modules and adds no other new one. **The general rule: a new step
   call needs no drain when it sits behind a condition that is false for every
   run started before the deploy, and the cheapest way to get that condition is
   an optional field on an existing journalled result whose absence means the old
   path.** Runs in flight still drain, for the ordinary reasons.
10. **A production campaign on real tickets**, covering at minimum: an
    automation rule commenting on the ticket, two people answering at once, an
    answer split by a blank line, a resubmitted answer, a ticket whose only
    candidate was excluded, a ticket with more than one page of comments, and a
    Jira read failing mid answer.

### Where each condition stands, 2026-09-16 evening

Written so the next person reads the state rather than reconstructing it. A
condition is only marked held when something was observed, never when it was
reported.

1. **Written, not yet gated.** The suppression chain is closed: a person's
   selection only ends the question when the run can actually reach that
   repository, and the ask recorded against a key no longer stands in for a name
   somebody saw. The outstanding piece is now written: the three repository
   questions raised directly in `prepare-workspace/execute.ts` go through the ask
   recorder, and `.min(1)` is off `workScopeAskedRepositoriesSchema`, so a
   question that listed no repository is a recordable fact and is read as a
   different fact from no question at all. Nothing here has been through a
   skeptic.
2. **Held for the cases found.** The loop that this stage's own gate introduced,
   where a fresh ticket asked the same question every round until the run budget
   killed it, was caught by a skeptic and fixed. Counting authors is split from
   writing, so a hold costs none of the three resume attempts, and it is bounded
   by a window with a give-up comment.

   A second way to fabricate a decision was found and closed the same day, and
   it is worth writing down because the first guess about it was wrong. The fear
   was that any comment containing a negation word became a permanent decline,
   which would have made an automation rule commenting in a person's name enough
   to exclude every repository a run asked about. Measured through the real
   reader, it is not: the words only decide when the whole comment is one of
   twenty refusal phrases, so "I'm not sure, let me check with the team" and
   "no action needed, moving to review" decide nothing. What is real is smaller
   and wider at once. Nothing threads a ticket comment to our question, so a
   colleague answering the comment ABOVE ours with "no" wrote the same permanent
   exclusion of everything asked, and no attribution check can help, because that
   person really did type it. A refusal that arrives as a ticket comment and does
   not say what it refuses now records nothing and asks again with instructions;
   "none", "none of these" and their kin record exactly as before. The dashboard
   and MCP channels are untouched: there the question is on the screen, so a bare
   "no" means what it says.
3. **Written, not yet gated, with one case still open and the screen deferred on
   purpose.** The record is editable through an authenticated route and an MCP
   tool, both over one service. Two defects in the telling half were found and
   closed today, and both are worth keeping in writing, because each was believed
   done before it was looked at.

   The first: the halt text on the founding case still told a person that no
   screen takes the exclusion back and that the way forward is a new ticket. That
   was true when it was written and false once the edit surface existed. It now
   composes from one source with every other sentence of its kind, two tests that
   carried the retired wording went red on their own, and a sweep over the module
   fails if any sentence it composes sends a person to a new ticket again.

   The second: the recovery sentence was routed on the belief that the halt text
   is the person's channel. It is not. The same joined string is prefixed onto
   the first question, and questions are rendered into the agent's research,
   implementation and review prompts and written into the run's memory file under
   "Human decisions". So a sentence telling an agent that somebody else's
   exclusion can be reversed was reaching the agent's instructions, signed as a
   person's decision. The channels are now split and guarded by a test that runs
   the real step and asserts the sentence reaches the person's text and neither
   prompt context nor memory.

   Closed: the founding case no longer reaches `prepare-workspace` as a bare
   "Which repository should this ticket modify?". The reasons already on the
   context are carried onto the first question the way the pre-sandbox halt
   does it (`apps/worker/src/engine/blocks/prepare-workspace/execute.ts:900`),
   so a person who was never told what the run had to leave out no longer reads
   "which of these" as a complete list. The channel question was established
   rather than assumed, and the answer was no: a ticket comment is NOT a channel
   the agent never reads, because comments are rendered verbatim into the next
   run's research prompt. The reversibility sentence rides it only because the
   failure path already does, and the lever a person actually has is the work
   scope edit, not the sentence.

   The dashboard panel stays stage 7; the owner was told this is a deliberate
   call and can overrule it.
4. **Still not zero, and the pattern has not broken once.** Every skeptic pass on
   this stage has found at least one blocker, including two that a reviewer had
   already approved in the same round. The pass run on 2026-09-16 evening found
   one more, and it was a regression created by this stage's own fix earlier the
   same day: raising the three bare questions through the ask recorder armed a
   fence that then withheld a person's own answer from the only reader that could
   have used it, and re-asked the identical question with nothing said. It is
   fixed, on the honest condition rather than the symptom (the answer is withheld
   only when the record DECLINED TO ATTRIBUTE it, never merely because no new
   entry was written).

   Two things are worth carrying out of that round beyond the fix. The reviewer
   filed the surrounding defect as a minor and asked whether it was intended,
   while the skeptic traced the same code to a person being asked the same
   question forever; the difference was not diligence but framing, which is why
   both lanes run. And the executor caught an error in the ADVISOR's instruction:
   arming the fence on the ask's `named` flag would have been permanently false
   in production, because that flag is stamped after the block returns, and only
   the executor's own hand-stamped fixtures made it look right.

   The final red team, run on 2026-09-17 over the whole user path rather than
   over a diff, found three more. Two were real and are fixed. The first is the
   founding complaint itself, reached by a door nobody had opened: an answer to
   the which repository question that the reader cannot resolve left the record
   empty, and the code suppressed the explaining sentence on the belief that
   answering a selection question settles it whatever it recorded. The SQL that
   belief rests on counts only answers of kind `none` or `repositories`
   (`db/repositories/work-scope.ts:102`), so neither the flag nor the sentence
   happened and the identical question came back in silence. A comment asserting
   what the statement beside it does not do is the same failure as a stale
   duplicate, and it is harder to see because there is only one copy. The second
   is that the way back from an exclusion named no way: the sentence promised the
   list could change and pointed at nothing, while the sentence directly below it
   already named a screen. The third, that an answer arriving after the question
   closed is lost whole, is TRUE and is the decision rather than the gap (A57,
   row A14b).

   What is worth carrying from this round is the shape of the pass, not its
   findings. The row-by-row audit run the day before checked every row against
   the code and agreed with the code, which is exactly what an audit anchored on
   rows must do. Every one of these three sat in a case no row described. A map
   is only tested by somebody starting from a person doing something.

   A zero-blocker pass has still never happened on this stage.
5. **Not yet.** The tree is not frozen while a lane is still writing.
6. **Not yet.**
7. **Partly.** Duplications are recorded with their dispositions in the section
   below. The facts-module consolidation is deliberately after the merge.
8. **In progress.** Two claims in this document were false and were corrected
   today: that origin precedence is encoded twice in TypeScript and SQL, and that
   this stage forces a drain of parked runs. The feature write-up still diverges
   from the code and is corrected once the code freezes.
9. **Held.** See the condition itself for why it narrowed.
10. **Not yet.**

### One deepening found while building, and since done

DONE in the design pass after the freeze, as `readWorkScopeFacts` and its
connected twin (`apps/worker/src/db/repositories/work-scope.ts`). The three
combiners now take one read: the run start step, the resume inside
`resolveHumanRepositoryExpansionStep`, and the read after an answer. The per-fact
reads stay, because each carries a rule that took a defect to get right and the
pure database tests sit on them one at a time, so the new read composes them
rather than restating them in one statement. Three connected twins nothing
reached any more were deleted. The rest of this section is kept as it was
written, because the measurement is the argument and it is worth reading before
the next interface of this shape is designed.

`loadRunStartSettingsStep` destructures four named reads from
`db/repositories/work-scope.ts` and runs them together, never skipping any. The
fifth fact added during this stage broke two test files that mock that module and
have nothing to do with the work scope, and it broke them at ACCESS time inside a
workflow body, so the symptom was "the run threw before it did anything" a long
way from the change.

The shape that would have made the addition free is one read returning the whole
frozen view, `{ scope, selectionAnswered, answeredRepositoryKeys,
narrowingAnswered }`, rather than four named reads the step composes. One import
at the step, one export at every mock, and a sixth fact changes the returned
object instead of the import list. The absence discipline already exists per
field, so a mock returning a partial object degrades to each field's documented
meaning instead of throwing.

The cost is that a caller could no longer take two of the four facts without the
others. Nothing does that today and both callers want all of them, which is the
definition of an interface that is wider than it needs to be.

### The production campaign, recipe by recipe

Condition 10 named seven cases without saying how any of them is produced, which
is how a campaign turns into a demo. Each recipe below says what to set up, what
to type verbatim, what must be observed, and which row of
[the behaviour map](../product/repository-record-behaviour.md) it proves. A
recipe that cannot be produced is a finding, not a skip.

Rules that bind the whole campaign, all learned the expensive way:

- Jira is driven only through the Atlassian Rovo MCP, never through a browser.
- A fixture ticket parked in the AI column is picked up by the poll, so fixtures
  wait in the backlog column and are moved deliberately.
- The planning QA harness definition is the cheap vehicle: it runs the decision
  path without an implementation, so a campaign of ten runs costs almost nothing.
- Nothing is written to the production database by hand. Every fact is produced
  by the product and read back through MCP or the API.
- A failure is evidence. A recipe that produces the wrong behaviour is recorded
  with what was typed and what came back, and it blocks the merge until the
  behaviour changes or the row changes.

| # | Case | Set up | Type verbatim | Must be observed | Proves |
|---|---|---|---|---|---|
| P1 | A person answers with a bare refusal on the ticket | A ticket with a repository question open | `no` | Nothing recorded, the clarification stays answered, the ticket does not move, a comment arrives telling them what to write, and the words offered are the ones this question actually used | A8, A15 |
| P2 | A person answers naming the subject | Same, a second ticket | `none of these` | Every repository the question listed recorded as their own decision to leave it out, and the question does not return on the next run | A7 |
| P3 | An automation rule comments under a person's name | A rule that comments on transition, pointed at the fixture ticket | Whatever the rule posts | Read the record and the trail: whatever was recorded is attributed to the named account, which is the known limit, and it must be visible rather than silent | A13 |
| P4 | Two people answer at once | Two accounts, both commenting before the next delivery | One writes `github:acme/api`, the other writes `none` | No entry written, the trail records that an answer arrived, both people told, and the run does not spend one of its three attempts | A12 |
| P5 | One person splits an answer across a blank line | One account, one comment | `no` then a blank line then `none of these` | Read as one answer, and the half that names the subject settles it | A17 |
| P6 | A resubmitted answer | Answer once, then edit the Jira comment | Any repository path, then a different one | Establish which one the system read, and whether editing a comment can change a decision after it was recorded. This one has no predicted answer on purpose | new row, to be written from what is observed |
| P7 | A ticket whose only candidate was excluded | Exclude the single candidate through the record's edit surface, then start a run | Nothing | The person is told what was left out and why, and is told the exclusion can be taken back and how. No sentence anywhere sends them to a new ticket | C4, C5, rule 4 |
| P8 | A ticket with more than one page of comments | A fixture with enough comments to page the Jira read | A repository path in the LAST comment | The answer is found, not lost behind the page boundary | A1 |
| P9 | A Jira read failing mid answer | Answer, then make the read fail for one delivery | Any repository path | The delivery holds rather than deciding, the hold costs none of the three attempts, and it is bounded by its window with a give-up comment | A12, rule 1 |
| P10 | The agent's channels | Any run that reaches research after a repository question | Nothing | Read the run's prompt and its memory file: the question and what was left out are present, and no sentence about reversing an exclusion is in either | D1, D2, D4 |
| P11 | The reversal actually works | After P7, edit the record to take the exclusion back, then start a new run | Nothing | The run uses the repository. A promise that a decision is reversible is worth nothing until a run proves it | rule 4, B5, B6 |
| P12 | A person names a repository nobody asked them about, and it is disabled | A ticket with no question open, and a repository the catalog holds but does not enable | The path written in an ordinary comment | The next run reads the ticket text, cannot use the repository, and SAYS SO to the person. The record refuses a derived key without asking anybody, which is right, but a refusal nobody hears is the silence this feature exists to end. If the run says nothing, that is the finding | A3, A5, rule 6 |
| P13 | The narrowing question is asked once | A ticket whose discovery finds more repositories than the question may list | Name two of them | What they named is the whole answer, nothing is recorded about a name they were never shown, and the same question does not come back on the next run | A16, rule 1 |
| P14 | A person answers the which repository question with words we cannot resolve | A ticket with the selection question open, on a deployment holding at least two repositories | `api and web` | A comment arrives saying nothing in that answer named a repository and what to write instead. The question may come back; the silence may not. This is the founding complaint of the whole feature and the only recipe that reproduces it directly | A11, rule 1 |
| P15 | A person answers after the question has closed | A ticket with a repository question open, then cancel the run | `github:acme/api` posted after the cancel | Nothing is recorded and the next run asks again, which is the decision. What must also be observed is that the ticket already carries the run's own comment saying why it stopped, so the person is not left with no account of anything. If that comment is missing, the decision loses its footing and the row changes | A14b |

P11 is the one that matters most, because everything else in condition 3 is a
sentence and that is the only step that turns the sentence into a fact.

## Stages

| # | Stage | Seam | File scope | Tier | Skeptic | TDD | Delegation | DoD |
|---|-------|------|------------|------|---------|-----|------------|-----|
| 1 | Contract: work scope, trigger policy | trigger policy validation | `packages/contracts/work-scope.ts` (new) and its test, `packages/contracts/index.ts`, `packages/contracts/workflow-graph.ts` (`BLOCK_PARAM_KEYS` only), `apps/worker/src/engine/definition/block-params-schemas.ts` (ONE shared parameter spread, applied to the eight trigger configurations behind the nine trigger types that start a run) and its test, the nine `apps/worker/src/engine/blocks/trigger-*/manifest.ts`, `apps/worker/src/engine/definition/deployment-validation.ts` and its test, the `pnpm gen:blocks` output, `CONTEXT.md`; the set of places mirrors how the rate limit reached every trigger | opus | no | yes | no | `pnpm run test:packages:zod4` green for the new contracts; block params tests green with a policy accepted on each of the eight configurations covering all ten trigger types, refused on `trigger_plan_approved`, an unknown key still rejected by `.strict()`, and a stored definition WITHOUT the field parsing exactly as before; `pnpm run typecheck` |
| 2 | Store: migration 0066, entries and trail | work scope store; decision trail append | `apps/worker/drizzle/0066_*.sql` plus the generated meta (a version row per subject, one entry row per subject and repository key with its persisted origin rank, the append-only trail whose row carries a subject, a run or both and never neither, a partial unique index making an answer apply once, and a nullable `asked_repositories` column on `clarification_requests` holding each asked key with the reason it was asked), `apps/worker/src/db/schema/work-scopes.ts` (new), `apps/worker/src/db/clarifications-schema.ts` (that column only), `apps/worker/src/db/repositories/clarification-hooks.ts` (the prepare insert accepts and returns the asked repositories), `apps/worker/src/db/schema.ts` export, `apps/worker/src/db/repositories/work-scope.ts` (new) and test | opus | no | yes | no | pglite tests: upsert, read by subject, an append and its entry update landing in ONE data-modifying CTE with no `db.transaction` in the module, TWO runs appending on one subject concurrently both succeeding and merging by origin precedence with no version pin, a person's edit still refused on a stale version, a trail row with no subject readable by run, a read returning entries and trail together, the trail filtered by kind, an answer plan applied once and `already_applied` on a retry or a concurrent twin; `pnpm run db:generate` produces no diff and the generated `.sql` contains no `$1` |
| 3 | Decision module (pure) | work scope decision; repository map rendering | `apps/worker/src/engine/work-scope/**` (new: decide, reconcile with catalog, map render, tests) | opus | yes | yes | no | one test per row of the decision table and one per sequence in the brief, including: expiry only of `not_enabled` and only on an activated catalog, `unusable` and `excluded` never expiring, an expired entry attached at run start only where a request would attach, each expansion rule applied to an INHERITED entry as well as a new request, the cap counted on the workspace (a record holding eight `selected` entries of which two attach still takes a request), an edit decided on its final set, each asked reason giving its own record on "none", a named unusable repository recorded `selected`, the "which of these" question asked at most once per subject, a provider outside the pin never attached or asked, the plan staying inside the contract bounds for the largest inputs, subject eligibility for all four trigger kinds, a `person` entry surviving a policy filter that removes every other inherited entry, map ranking, the twenty five repository threshold and a request for a key outside the map being allowed; no imports from services or db (`workflow-import-boundary.test.ts` green) |
| 4 | Run integration | run-start freeze; selection from scope; expansion from scope; cross-run engine test | `apps/worker/src/engine/steps/run-start-settings.ts`, `apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts`, `apps/worker/src/engine/steps/phase.ts`, `apps/worker/src/engine/repository-discovery/runner.ts` (integration lines only) and its tests in `apps/worker/src/services/repository-discovery/runner.test.ts` (the source file there is a one line re-export), `apps/worker/src/engine/agent-workflow.ts` (ctx wiring only), `apps/worker/src/services/clarifications/answer-core.ts` (decide and record the answer on arrival, the answer as read in the hook payload), `apps/worker/src/engine/blocks/prepare-workspace/execute.ts` (the answer as read instead of the synthetic comment), `apps/worker/src/engine/blocks/fetch-pr-context/execute.ts` (pull request runs start from the scope), `apps/worker/src/engine/tests/**` | opus | yes | yes | no | engine test: run 2 inherits run 1's entries and asks nothing; a run that dies right after an answer leaves the answer recorded and the next run asks nothing; a pull request run attaches a repository a person selected on its subject; the bot's own clarification comments are excluded from the ticket text the matcher reads (`apps/worker/src/engine/pre-sandbox/steps/repo-selection.ts:1136`); every trail append rides a step with `maxRetries = 0`, listed in the brief; a question stores its asked repositories and reasons; no guard rail of the protocol reaches a person; AIW-402 scenario passes; the trigger policy is resolved at run start from the deployed graph and filters inherited entries with `person` exempt; every attach, every refusal and every person answer appends exactly one trail line carrying the repository, the origin and the reason, and a parked run resumed twice still appends it once; a test fails if any append happens in workflow scope rather than inside a step; the brief lists every path by which data from one run reaches a later run on the same subject (the clarification history read, the pre-sandbox current answer, the label routing memory, the approved plan, the human decisions memory, repository memory, trigger output), and for each the DoD shows it can no longer change a repository decision, or says why it never could (AIW-402 asks for exactly this audit); a `plan_approved` run ignores the subject scope and still refuses expansion; a replayed run-start output without the field takes the whole old path; `step-registration-coverage` and `workflow-import-boundary` green; no step added, removed or reordered (reviewer diffs the file); merge only under a drain proved by a query, zero `running` and zero `awaiting` agent-workflow rows and an empty `active_runs` |
| 5 | Repository map in the agent context, including the sentence AIW-377 asks for (an `access: read` research checkout does not block implementation, so the model stops requesting an attached repository again for write) | repository map rendering (integration); what the agent was shown | `apps/worker/src/sandbox/context.ts`, `apps/worker/src/engine/repository-discovery/protocol.ts` (prompt text and request-by-key), `apps/worker/src/sandbox/context.test.ts` | opus | yes | yes | no | rendered prompt for a 40 repository catalog stays at 12 map lines and under 1600 characters (the repository has no tokenizer, so the budget is counted in characters); a 20 repository catalog renders whole; a request by a map key attaches; a request for a catalog key the map did not show still attaches; only a key outside the catalog or outside the policy is refused; the map recorded by stage 4 reads back through `work_scope.get` identical to the text that was rendered; and the sentences saying WHY a repository was left out reach the person on a run that SUCCEEDS, not only the model's prompt and the halt message (stage 4 put them in front of the questions on a halt, which is the only screen a person reads there, and left the successful run telling nobody) |
| 6 | Trigger policy in dispatch and the flow editor | trigger policy validation (runtime) | `apps/worker/src/services/dispatch/**`, `apps/worker/src/services/manual-dispatch/resolve.ts`, `apps/worker/src/services/repository-catalog/pins.ts`, `apps/dashboard/components/cockpit/flow-editor/blocks/index.ts:75-86` and the TEN `blocks/trigger_*.tsx` field components (copying the shared group pattern of `blocks/pr-trigger-fields.tsx` and `blocks/shared.tsx`), `apps/dashboard/components/cockpit/flow-editor/repository-scope-bar.tsx` (its copy becomes "the default a trigger inherits unless it sets its own"), `docs/architecture/workflow-definition.md` | sonnet | yes | yes | no | dispatch tests: each kind default per A2, including a webhook with and without a subject path and a schedule under both overlap policies writing no record at all, and a pull request whose catalog carries no relationships falling back to the enabled catalog; explicit policy overrides the pin; the pin still applies with no policy; dashboard test renders and saves the field group |
| 7 | Surfaces: API, MCP, ticket screen, run report | MCP parity; run repository report | `apps/worker/src/routes/api/v1/work-scope/**` (new), `apps/worker/src/mcp/tools/work-scope.ts` (new), `apps/worker/src/mcp/tools/runs.ts` (one tool added), `apps/worker/src/mcp/tool-catalog.ts`, `apps/worker/src/mcp/server.ts`, generated contract, `apps/dashboard/app/(cockpit)/ticket/**`, the run detail screen, `apps/dashboard/app/api/work-scope/**` (new) | sonnet | yes | no | yes | `mcp:contract:check` green with the three tools; route tests for read, update, conflict; `runs.repositories` returns the repositories used with their rationale, the rounds, the requests with a verdict each and the map shown, and answers clearly rather than emptily for a run that recorded none; dashboard test: panel lists entries and an edit sends the version |
| 8 | Evidence, docs, roadmap | none (verification) | `changelog/unreleased/*.md`, `docs/product/roadmap-2026-08-27.md`, `docs/index.md`, `docs/qa/**` | sonnet | no | no | no | six production runs per A9 recorded with run ids, each judged on its trail rows; AIW-402, AIW-377 and the roadmap P1 item commented; changelog entries present |

### The one step this stage adds, and why it needs no drain

Stage 4's own DoD says "no step added, removed or reordered". One was added, so
this says which, and why the runs in flight are safe from it. A step's identity
is its module path plus its function name, and the Workflow DevKit resumes by
consuming a run's journal in order, so the only thing that strands a suspended
run is a step call it reaches that its journal does not hold.

`readWorkScopeAfterAnswerStep` (`apps/worker/src/engine/steps/clarification-hook-steps.ts:151`)
is new. It has exactly one call site, `apps/worker/src/engine/agent-workflow.ts:1580`,
and it sits behind `if (workScopeAsk && ctx.workScope)`. A run that started
before this ships cannot satisfy that condition:

- `ctx.workScope` is set only from `runStartWorkScope(runStart)`
  (`agent-workflow.ts:1181`), and that function is `stored.workScope ?? null`
  (`engine/steps/run-start-settings.ts:254`).
- `runStart` is the REPLAYED journal entry of `loadRunStartSettingsStep`, whose
  result was written by the old code and carries no `workScope` field, so the
  read gives null and the key is absent from the context.
- `loadRunStartSettingsStep` keeps its module path and its function name, so its
  identity is unchanged. Its input and its result shape changed, and both sides
  are read defensively.

Two neighbours that look like additions are not. `listFreshRepositoryCatalogStep`
already existed at the same call site before this branch (checked against the
merge base); only the binding of its result changed. `resumeFromWorkScope`
(`engine/steps/phase.ts`) is a plain async function inside
`resolveHumanRepositoryExpansionStep`, which is already a journaled step, so it
re-executes for nobody.

No journal ordinal moves for a run in flight. The drain query stays as a
deploy-time measurement rather than a merge blocker, and the number it returns
goes in the evidence either way.

### What moved out of its stage, and why

Three things shipped in stage 4 that this table books elsewhere. They are
recorded here because a stage planned against a table that is already wrong is
how the same work gets done twice.

1. **The sentences saying why a repository was left out, on a run that
   SUCCEEDS** (stage 5's DoD). Stage 4 put them in front of the questions on a
   halt, and that is the only screen a person reads there, so a run that
   finished short-handed still told nobody. It is the founding complaint wearing
   a new name, it rides the same `ctx.workScopeLeftOut` stage 4 already carried,
   and waiting a stage for it would have shipped the defect deliberately. It
   lands in the run's comment on the ticket, which is the only surface that
   reaches a person on a run that did not halt (case C10).

2. **The read and edit surface**: `GET` and `PATCH /api/v1/work-scope`, and the
   MCP tools `work_scope.get` and `work_scope.edit` (stage 7). The owner's
   requirement was that a recorded decision be reversible in the delivery that
   records it, not in the next stage, and P11 of the production campaign exists
   to prove the reversal with a real run. The dashboard panel and
   `runs.repositories` stay in stage 7.

3. **`RunAnalysisReport` gained three optional fields** (`leftOutRepositories`,
   `repositoryRecoveryNotes`, `leftOutRepositoriesOmitted`) against the rule
   above, that a stage needing a different shape returns a question rather than
   widening the contract. The question was returned and the advisor widened it,
   because item 1 has no other surface. All three are optional and absent rather
   than empty, so a report written before they existed still parses.

Stage 4 runs as five waves, because one executor holding every integration at
once is how a stage this wide gets a guessed decision in it. Wave 1 freezes the
record and resolves the trigger policy at run start and touches nothing else.
Waves 2 and 3 then run in parallel on disjoint files: wave 2 decides and records
a person's answer where it arrives, wave 3 makes the workspace start from the
record on both the ticket and the pull request path. Wave 4 is the in-run
expansion. Wave 5 is the cross-run audit and the production reproduction, and it
writes no production code. Each wave carries its own gate; the branch merges once,
under the drain.

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
2. After stage 4 deploys: the same ticket, twice, judged on the trail through
   `work_scope.get`, not on whether the run succeeds (a run without the
   repository may still fail, which is what step 1 also shows). First
   dispatch: `question_asked`, `question_answered` "none", and the entry
   `unavailable` decided by the person (A23). Second dispatch: a
   `request_refused` `unavailable` for that repository and no `question_asked`.
   A dispatch in which the model never requests the repository proves nothing
   and is recorded INCONCLUSIVE, not PASS.
3. Enable-later path: a fresh ticket naming a repository disabled in the
   catalog, answered "continue without it"; enable the repository; a second
   run attaches it at run start without a question (the trail shows the
   expired entry replaced). The catalog change is reverted after.
4. After stage 5 deploys: a vague ticket (the campaign's T6 shape) resolves
   its repositories from the map without a repository question.
