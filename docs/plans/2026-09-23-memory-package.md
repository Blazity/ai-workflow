Status: draft
Last-verified: 2026-09-23

# Agent memory: one module, Mem0 as a real search store, visible end to end

Base: `origin/main` at `c8339fb4045757678685578ac9f48e148437594a`. Production
`/health` reported `be3d9418a796d82a6df3aaeac5a8ed00cb606855` during recon.
Task brief: `lanes/prompt-memory-rebuild.md`. Audit leads:
`lanes/memory-audits-2026-09-23.md` (each lead re-verified below; several were
wrong or incomplete).

## Problem

For the people who use it, agent memory is a black box.

- An engineer reading a run cannot answer "why did the agent not remember X".
  The run page shows what memory was sent (Briefing tab), but not what was
  left out and why, not what the run learned, and not what it failed to store.
  The distill step's output is stored nowhere visible; its input is reachable
  only through the API, and the UI node for it redirects away.
- `/memory` shows one row per document with the last writer's run id as plain
  text. One wrong fact can only be removed by deleting all 40. There is no
  history, no per-fact provenance, and the page does not say which store it
  lists.
- An admin who connects Mem0 sees memory "vanish": nothing is copied, the old
  store becomes invisible and unerasable from the UI, and the disable preview
  promises in-flight runs "go on without memory" while in fact their next step
  silently switches store.
- Mem0 is used as a paid key-value list: every prompt build lists every
  document of every repository (2N+1 list calls), search is never called,
  updates are delete-and-add, and the ticket notebook (up to 256 KiB) is
  stored as one Mem0 memory.
- The ticket notebook is not persisted on workflow 14 (observed on
  production: no ticket document after three runs), and the step reports it
  nowhere.

## Solution

- Memory is one module in the worker with a small interface. Stores are
  adapters behind a narrow port. Steps stay where they are and become thin.
- The ticket notebook always lives in the built-in store. Facts and lessons
  live in the active store.
- Recall is a query built from the ticket: Mem0 ranks by relevance, the
  built-in store returns everything within limits. Facts are updated in place
  when the agent learns they changed.
- Every memory event of a run (what was recalled, what was left out and why,
  what was stored, updated, removed, rejected, redacted, withheld, or lost to
  an unavailable store) lands in one append-only ledger. The run page gets a
  Memory card, `/memory` gets per-document history and a search, MCP gets the
  same reads.
- A run keeps the store it started with. Switching stores never mixes one run
  across two stores. The inactive store stays visible and erasable, and an
  admin can copy entries across on purpose.

## Users and situations

| Who | Arrives in what state | Trying to get done |
|---|---|---|
| Admin connecting Mem0 the first time | Built-in holds facts from past runs, Mem0 account empty, maybe on Hobby quota | Switch without losing what the agent learned, know it worked |
| Admin going back to built-in | Mem0 holds weeks of facts; built-in holds stale pre-switch facts | Switch back, understand which facts the agent will now see |
| Engineer after a run | "The agent redid X we fixed last week", run is finished or failed | Find in a minute whether X was ever stored, where, and why it did not reach the prompt |
| Engineer or admin cleaning up | One wrong or sensitive fact | Remove that fact, not the whole document, and know it is gone everywhere |
| Agent through MCP | Reviewing a run or a repository, no dashboard | The same answers the dashboard gives: store, recall report, ledger, documents |
| Run in flight during a switch | Started on Mem0, suspended awaiting a human, admin flips the store | Continue predictably; never split one ticket across two stores |
| Run while Mem0 is down, key rejected, or quota spent | Normal run | Finish the work; tell the agent memory is missing; record what was lost |
| Run on a repository another run is writing to | Parallel tickets on one repo | Neither run loses the other's facts |

## User stories

1. As an admin I connect Mem0 and `/memory` tells me Mem0 now serves facts and lessons, that the built-in store still holds N entries, and offers to copy them.
2. As an admin I switch back to the built-in store and see the same, in the other direction.
3. As an admin I see, before I disable a store, what happens to runs in flight, and afterwards the switch is on the `/memory` timeline.
4. As an engineer I open a run and see one Memory card: store used, query, entries recalled, entries left out with reasons, entries learned, updated, removed, rejected, redacted, and notebook saved or not with the reason.
5. As an engineer I search `/memory` for a phrase and see every ledger event that touched it: which run added it, which run changed it, which admin removed it.
6. As an engineer I open a document and see its history and, per entry, the run and ticket that taught it (linked).
7. As an engineer I forget one entry without losing the rest of the document.
8. As an engineer I can still read and erase entries in the inactive store.
9. As an agent through MCP I list documents, read one, read its history, read a run's memory report, and forget one entry, with the same answers as the dashboard.
10. As an agent in a run I get the facts relevant to my ticket first, I am told when memory was unavailable, and my notebook is there on the next run of the same ticket.
11. As an admin I see on `/memory` whether the active store answered recently, and the last error with its reason (key rejected, quota, timeout).
12. As a developer I open one module and one document and understand all of memory: kinds, limits, policy, redaction, recall, learning, stores.
13. As a developer I add a new memory store by implementing the port and passing the conformance suite.

## What good looks like

- "Why did the agent not remember X" is answered from the run card and the
  `/memory` search, without logs, in a minute.
- Nothing about memory is silent: every refusal, cut, drop and redaction is a
  ledger row with a reason a human understands.
- A store switch is boring: runs keep their store, the UI says what moved and
  what did not, nothing is lost or duplicated.
- Merely passing would be: the ledger exists but only the happy path writes
  to it; Mem0 search is called but the report cannot say what it left out;
  the card shows counts without the entries.

## Verified facts that shape the plan

Everything below was re-verified in code at the base SHA, on production
(read-only) or in current Mem0 docs. Citations are `apps/worker/src/` unless
another root is given.

Code:
- Port: `integrations/sdk/memory.ts` (584 lines), `MemoryAdapter:456`,
  `MemoryStoreAdapter:542`, budgets `:161` (16+16 KiB), caps `:176` (40/30),
  notebook `:186` (256 KiB). No memory coverage in `integrations/sdk/conformance.ts`.
- Provider choice is resolved per step from live rows (`engine/support/memory-runtime.ts:138`,
  every caller unpinned: `engine/steps/memory-steps.ts:139,334`,
  `engine/steps/repo-memory-steps.ts:858,1727`, `engine/steps/repo-seed-steps.ts:160`).
  The pin check exists but nothing calls it (`memory-runtime.ts:139-158`), and
  it returns built-in before checking (`:197-201`). The run-start snapshot
  records no memory choice (`engine/steps/run-start-settings.ts:125-140`).
- Setting `AIW_MEM0_API_KEY` alone switches memory to Mem0 with no click
  (`services/integrations/resolve.ts:80-86`). Production uses a dashboard-stored key.
- Secret scrubbing for memory is one implementation (`memory/known-secrets.ts:85`),
  exact values only; routing has its own (`engine/pre-sandbox/steps/repo-selection.ts:1105`).
  The audit's "three scrubbers" was wrong.
- "Same entry" is decided three ways: built-in normalised key (`memory/builtin/adapter.ts:176`),
  Mem0 exact text (`integrations/mem0/memory.ts:162,234,287`), promotion
  `repoMemoryComparisonKey` (`repo-memory-steps.ts:1117`). Promoted org facts
  can reach the prompt twice under Mem0.
- Notebook path is spelled in at least nine files (`memory-steps.ts:27`,
  `builtin/adapter.ts:101`, `infra/publication-scrub.ts:22`,
  `write-human-decisions-memory.ts:41`, `disposable-review-workspace.ts:19,194`,
  `trusted-workspace-publisher.ts:700`, `sandbox/git-excludes.ts:36,83`,
  `repo-memory-steps.ts:178`, prompts). Five size limits, not three.
- Routing memory bypasses the port and the provider (`repo-selection.ts:852-1163`).
  It maps a ticket label to the repository a human picked, used only when
  deterministic selection declined, after two distinct tickets agree
  (`memory/repo-routing.ts:4-26`). It duplicates the repository work scope
  record (`db/schema/work-scopes.ts`, `engine/work-scope/`), which repo
  selection already reads (`repo-selection.ts:592`). Off on production, no
  data. `pre-sandbox/steps/repo-selection.ts` is a one-line re-export; the
  live code is `engine/pre-sandbox/steps/repo-selection.ts`.
- `distillRepoMemoryStep` never receives `reviewNotes` (declared `repo-memory-steps.ts:655`,
  call `engine/agent-workflow.ts:5181-5230`). Facts carry no ticket key
  (`repo-memory-steps.ts:1027,1141`).
- Teardown refusals reach only `console.error` (`agent-workflow.ts:5120-5146,5234`).
  Recall cuts are Pino-only (`repo-memory-steps.ts:2015-2023`).
- Recall runs on every prompt build (`agent-workflow.ts:4709-4742`); the
  notebook is not injected, only its path is in the prompt text.
- WDK: step id is path plus function name, and a changed sequence of step
  calls fails replay with `ReplayDivergenceError`
  (`docs/plans/2026-09-09-architecture-restructure.md:441-460`). Hence the
  hard rule below: no step added, removed, renamed or moved.
- Latest migration `apps/worker/drizzle/0072_integrations_contract.sql`;
  `db:generate` needs no database.

Production (read-only, 23.09):
- Mem0 serves memory ("Served by Mem0", dashboard-stored key, tested 11:08 UTC).
  MCP `memory_list` (after OAuth, full record in
  `lanes/qa-memory-baseline-20260923.md`) returns 4 documents and no provider
  field: `aiw-checks-fixture` facts (5) and lessons (1), `ai-workflow-demo`
  facts (4 seeded setup facts), and a ticket notebook `ticket:jira:AWP-274`
  at `notebook/AWP-274` (1510 B, a "Human decisions" block) written at 12:56
  UTC. Notebooks are already in Mem0, and the notebook fix merged at 13:01
  (production `42e3793b`), so every ticket run now adds one.
- The notebook path has a Mem0 spelling, `notebook/<KEY>`
  (`integrations/mem0/memory.ts:114`); `memory_get` on the built-in spelling
  returns NOT_FOUND under Mem0, although the MCP description promises it.
- Items carry no per-item provenance; `sourceRunId` names the last writer
  (AWP-272) although four of five facts came from AWP-270.
- `system_capabilities` shows memory served by mem0, no reasons, no built-in.
- A `memory_unavailable` attempt observation is overwritten by any later
  metadata event (`run-observability/runtime-hooks.ts:191-193`); production
  attempt 3994 lost its envelope. Its absence proves nothing.
- AWP-271 (`wrun_01M370G5…`) and AWP-272 (`wrun_01M37308…`) both received the 4
  facts AWP-270 taught (Briefing, 371 B). The audit's "recall always empty"
  risk is refuted for `infer:false`.
- The distill send exists in the briefings API (5.1 KB, input only) but the UI
  node redirects to `status`; the run says "4 sends, all recorded" and shows 3.
- The `/memory` switch copy claims the notebook "is always hydrated and
  persisted", which production contradicts.
- MCP was not authenticated in this session; MCP reads are owed to stage 1.

## Implementation decisions (one-way doors)

### D1. The memory module lives in the worker, not in `packages/`

`apps/worker/src/memory/` becomes the one module, with a single public entry
(`memory/index.ts`). It sits in the engine tier, which ADR-001 already assigns
to `memory/` (`scripts/gates/tiers.json:48`), and may import `integrations/sdk`,
`db`, `infra`, `packages/*`. A boundary rule is added to the gates: code outside
`memory/` imports only `memory/index.ts`.

Rejected: a workspace `packages/memory`. ADR-001 lets packages import only
`packages/contracts` and requires two consumers; the core needs the database
and the SDK port, and Mem0 (under `integrations/`) may not import a package.
It would force either an ADR-001 change or a package so thin it is a
pass-through. No ADR-001 change is needed.

The prompt section is still rendered by `packages/prompts` (the compiler owns
all sections and the briefing hashes); the memory module hands it structured
recall output and the caveat text. Moving rendering into the worker would
invert the dependency.

### D2. Memory port v2 in `integrations/sdk/memory.ts`

Stores become thin: they hold, recall and apply. Policy (caps, "same entry",
redaction, budgets, eviction) moves to the core, so every store behaves the
same. The notebook leaves the port (binding decision: always built-in). This
is a breaking reshape of an SDK port, so ADR-010 gets an amendment, and v2 is
introduced additively (v1 stays until the cut-over is proven, then is
removed).

```ts
type MemoryKind = "facts" | "lessons";
type EntryOrigin = "learned" | "derived" | "imported";

interface MemoryEntry {
  id: string;              // store-stable; built-in derives it from the normalised text
  subject: string;         // repo:… | org:…
  kind: MemoryKind;
  text: string;
  origin: EntryOrigin;
  runId?: string; ticketKey?: string; updatedAt?: string;
  score?: number;          // present only when the store ranked the result
}

interface MemoryStorePort {
  // Prompt path. Returns the COMPLETE set for the subjects and kinds.
  // With a query, a store that can rank returns it ordered by relevance
  // (ranked:true, score set); otherwise in stored order (ranked:false).
  // Relevance orders, it never filters: the core cuts only by budget and cap.
  recall(r: { subjects: string[]; kinds: MemoryKind[]; query?: string }):
    Promise<Answer<{ entries: MemoryEntry[]; ranked: boolean }>>;
  // Write path. The complete set for one subject and kind, so the core can
  // dedupe, update and apply caps. Never ranked.
  held(r: { subject: string; kind: MemoryKind }):
    Promise<Answer<{ entries: MemoryEntry[]; version?: string }>>;
  // One call per subject and kind; per-item outcomes, never a bare count.
  // An outcome carries the resulting entry id (a store may change the id on
  // update; the ledger chains old id to new id).
  apply(r: { subject: string; kind: MemoryKind; runId?: string; ticketKey?: string;
             ifVersion?: string;
             add: { text: string; origin: EntryOrigin }[];
             update: { id: string; text: string }[];
             remove: { id: string; reason: "refuted" | "cap" | "forgotten" }[] }):
    Promise<Answer<{ outcomes: EntryOutcome[] }>>;
  // Admin: list documents, read one, forget one entry or a whole document.
  list(…); get(…); forget(r: { subject: string; kind?: MemoryKind; entryId?: string });
}
```

`Answer` is the existing refusal union (`unavailable`, `rejected`, …). The
exact names are open to stage 2. Fixed: neither recall nor held may drop
entries silently. A relevance cut inside the store would make the card say
"left out 0" while the agent missed a fact, and would break dedup, caps and
refutation on the write path. The built-in store keeps today's markdown
format and derives ids from the normalised text, so a revert to v1 still
reads everything it wrote; an update there is remove plus add, linked in the
ledger.

Two Mem0 realities shape the port. A store declares whether it may
consolidate entries on its own (Mem0 may; built-in never). For such a store
the core compares `held` with the ledger on every distill and records ids that
vanished or were superseded (`superseded_by_store`), and recall excludes
entries with `replaced_by`, reporting them. Forget matches by the
normalised-text hash, not by id: it removes every matching entry in both
stores (duplicates from parallel runs included) and blanks every ledger row
whose text, previous text or detail item matches the hash.

### D3. The memory ledger: one append-only table for every memory event

The approved "history of memory writes" table is widened to every memory
event of a run, so a run has one timeline. Name `memory_events`. Rows:

- `recalled` (one per prompt build: store, query excerpt, entry ids sent,
  entries left out with reason `budget` or `cap`, `ranked` flag),
- `added`, `updated` (with previous text), `removed` (reason `refuted`, `cap`,
  `forgotten`), `duplicate`, `rejected` (reason: too long, platform path, URL,
  file absent on default branch, store refused), `redacted`,
- `notebook_saved`, `notebook_withheld`, `notebook_absent`, `notebook_truncated`,
- `unavailable` (where, reason, and for writes the items that were lost),
- `contradicted` (matched an entry or matched nothing), `confirmed` (a
  re-asserted fact, re-stamped), `rejected` with reason
  `self_contradiction` (asserted and contradicted in one run),
  `superseded_by_store` (the store consolidated it),
- `imported` (copy between stores or the notebook sweep), `store_changed`
  (written by the admin's enable, disable, connect and disconnect requests in
  `services/integrations/authoring.ts`, with actor, from, to and the Mem0
  identity; an env-only change is derived at run start and labelled "from
  environment").

Conservation: every claim a distill returns ends in exactly one ledger row, so
"what did this run conclude" is always answerable.

Columns carry run id, actor (`run`, `admin:<user>`, `mcp:<client>`), store,
subject, kind, entry id, redacted text, previous text, reason, ticket key,
bytes, and a small JSON detail. Texts are redacted before insert, NUL
characters stripped, and reads redact again with the current secret set (a
value that became a secret later never shows in clear). Every insert is one
statement (neon-http). Writes happen inside existing steps, never in a new
step.

Ledger writes are best effort: they run after the store call, never throw out
of the step, and a failure is logged to Pino with the run id. Memory must
never be lost because its record failed. The table is append-only; the only
permitted change to an existing row is blanking text on erasure (Q2).

Skipped memory work is explained, not silent. The gates live in workflow code
(`agent-workflow.ts:4709`, `:5128`, `:5163-5175`), where no ledger write may
happen. The reader derives "memory off", "run failed" and "not published"
from the run row and the frozen settings; the budget verdict travels as an
optional input to a later existing step, or the reader derives it from the
run's recorded budget. Retention and erasure follow Q2.

Logs: every store call and every refusal emits one structured Pino line
(`runId`, store, subject, outcome, HTTP status, duration); `console.error`
reporting of memory refusals is retired. The `memory_unavailable` attempt
observation is retired in favour of the ledger, because attempt metadata is
overwritten by later events. When a ledger insert fails, the run memory
reader compares the store's entries carrying this run id (Mem0 keeps `runId`
metadata, built-in keeps it in the provenance suffix) with the ledger and
shows "record incomplete" with the missing entries.

### D4. A run keeps the store it started with

The run's memory store is pinned through the existing
`workflow_runs.integration_pins` (`db/schema/runs.ts:128`), with an explicit
built-in marker, so the runtime and the disable preview
(`services/integrations/impact.ts:118,158`) read one source. The Mem0 pin
includes the Mem0 organisation and project: a key save and a Test call
`GET /v1/ping/` once and store `{orgId, projectId}`; the run-start step copies
it into the memory pin; later calls compare with the stored identity, never a
live ping. Rotating a key within the same project continues; a key for
another project is a store change. An env-only key never tested has unknown
identity, counts as "same", and gets a ledger note. Widening the pin type in
`packages/contracts` is a contract change: Q6.
Every later memory call of that run uses the pin. If that store is disabled,
disconnected or swapped later, the run's remaining memory calls answer
`unavailable` with reason `store_changed`, recorded in the ledger; they never
fall through to the other store. This makes the disable preview's promise
true and its count correct. Runs started before the deploy have no memory pin
and keep today's live resolution. The stale comment at
`engine/support/memory-runtime.ts:141-149` (pins would strand runs) is
corrected: WDK replay compares only correlation id and step name
(`@workflow/core` 4.8.0 `dist/step.js:55-67`), never arguments.

Rejected: falling back to the built-in store when Mem0 fails. It splits one
subject's facts across two stores and makes the next recall disagree with the
last write.

### D5. Recall by query, Mem0 search for ranking

The core builds the query from the ticket title and description (redacted,
length-capped). Relevance decides the ORDER in which entries fill the prompt
budget, never whether an entry is eligible. Mem0 recall uses
`POST /v3/memories/search/` with `filters` on `app_id`, `user_id in [subjects]`
and `agent_id in [kinds]`, `threshold` 0 and `top_k` at least the held size,
so every entry comes back with a score. If the live probe shows search cannot
guarantee completeness, the adapter lists the set and orders it by the search
scores, and any held entry search did not score is placed after the scored
ones and reported `not_ranked`. Derived entries always go first. With no query
text, recall is the list in stored order. The built-in store ignores the
query. The step sequence is unchanged; the number of HTTP calls inside the
recall step is free (it does not affect replay), and the target is at most
two Mem0 calls per prompt build instead of today's 2N+1 lists.

For a small memory (production today: 6 entries, 371 B) the agent gets
exactly what it gets today. Ranking matters once a run touches many
repositories or an org, when the budget forces a choice.

### D6. Updates are updates

The distiller may emit "this known fact changed to …". The core turns it into
`update`; Mem0 uses `PUT /v1/memories/{id}/` (keeps id and Mem0 history), the
built-in store replaces in place. The ledger keeps the previous text either
way. Refuted facts stay real deletes. An entry written as immutable (every
Mem0 entry from before 6b) cannot be PUT: it is updated by delete plus add,
the ledger chains the ids, and Mem0 history is not carried over. Whether new
writes keep `immutable` (exempt from consolidation, no PUT) or drop it (PUT,
exposed to Merge) is decided from the stage 5 probe, which tests both.

### D10. One memory switch, and org knowledge by proposal, not by coincidence

Decided by Filip on 23.09 (Q10 (b) plus the org redesign).

- One switch: the existing `ENABLE_REPO_MEMORY` key stays (renaming a
  settings key is a contract change for no gain) and is shown as "Agent
  memory", default on. It is the kill switch for everything memory does.
  `ENABLE_ORG_MEMORY_PROMOTION` is removed (stage 10, with routing; the promotion code
  itself is replaced in 6b), and its switch leaves `/memory` in stage 9.
- The "two repositories agree" promotion rule
  (`repo-memory-steps.ts:1078-1178`) is removed. It measured coincidence, not
  scope, needed near-identical sentences, and spread facts to every repository
  of an owner silently, which is also the widest blast radius for a wrong or
  poisoned fact.
- Instead, the distiller labels every claim's scope: this repository, or the
  organisation and its process (pull requests, commits, the tracker, deploys,
  team conventions). Org-scoped claims never land in `org/` directly: they
  become proposals in the `/memory` "Needs review" inbox, with the tickets and
  repositories that raised them. When a similar claim shows up in another
  repository of the same owner (Mem0: search by meaning; built-in: word
  overlap on the normalised text), the proposal gains that evidence. It is a
  signal for the human, not a threshold.
- A human promotes with one click ("Move to org", "Keep in repo", "Dismiss");
  every fact in the folder tree also offers "Move to org" or "Move to repo".
  Ledger events: `proposed_org`, `promoted`, `kept_local`, `dismissed`,
  `moved`. The run card says "Proposed N org facts, waiting for review".
- `org/` is a folder like any other: the agent reads it itself when it deals
  with process, and nothing from it is pushed beyond the always-on core.
- The inbox is the same place that holds agent disputes and lessons that
  weaken a gate (see the quality and routing design), so a human has one
  queue, with a count in the navigation.

### D7. Steps keep identity; no drain

No `"use step"` function is added, removed, renamed or moved; no step call is
added to or removed from any workflow function; step inputs and results only
gain optional fields. Logic moves out of steps into the module. Therefore no
drain is planned. If an executor finds a change that breaks this, it is a
stop-and-ask, and the drain protocol in
`docs/plans/2026-09-09-architecture-restructure.md` (section "Step identity
and the drain rule") applies.

### D8. The built-in store is never "inactive"

The built-in store always serves notebooks (binding decision). "Active" and "inactive" apply only to facts and lessons. The
store panel says so, and copy counts and erase actions on the inactive store
cover only facts and lessons; a notebook can never be copied to Mem0 or
erased by an "old store" cleanup.

### D9. Notebooks stop going to Mem0 now, and the ones there are swept

Production Mem0 already holds notebooks and gains one per ticket run. Stage 1b
(right after stage 1) sends notebook hydrate and persist to built-in only.
While built-in has no notebook for a ticket, hydrate also reads the legacy
Mem0 notebook (`notebook/<KEY>` maps to `ai-workflow/memory/<KEY>.md`); when
both exist it keeps the newer and appends the older under a marker, so a
human decision written to Mem0 is never shadowed. If the Mem0 leg fails,
hydrate reports `recalled:false` so teardown withholds instead of
overwriting. Stage 6a adds a one-time batch sweep (owner-only, dry run
first): every Mem0 notebook is written to built-in with the same merge rule
and recorded `imported`. Deleting the Mem0 copies happens in stage 11 (Q5). Stage 11 removes the
legacy read once every Mem0 notebook has an `imported` row. Until then
`/memory` and MCP list Mem0 notebooks as "legacy, moved" or "legacy, not yet
moved".

**Changed by Q14 (25.09):** there is no sweep and no legacy read. Stage 1b
only stops new notebooks going to Mem0; the ones already there are forgotten
with everything else Mem0 holds right after 6a merges.

## Decisions by Filip (23.09.2026)

These were the one-way doors the brief did not settle. Filip accepted every
recommendation on 23.09 ("dawaj wszystkie rekomendacje"); they are binding
for the executors.

- **Q1. Copying entries between stores** (touches production Mem0 data). Options:
  (a) never copy, as today; (b) an explicit admin action on `/memory`, "Copy N
  entries from the other store", with a dry-run preview, idempotent by
  normalised text, both directions, recorded as `imported`; MCP reads its
  status but cannot trigger it; (c) automatic copy on switch.
  **Decided: (b).** The preview is computed through the core's apply plan
  (dedup, caps, bytes), so what lands equals what was shown. It also lists
  entries that were refuted or updated on the other store while it was active
  (from the ledger) and offers to drop them here too, and it counts entries
  pinned runs wrote to the inactive store after the switch. Stage 8 depends
  on it.
- **Q2. The ledger and erasure.** When someone forgets an entry or a document,
  (a) the ledger keeps the full text forever, (b) the ledger keeps who, when,
  what action and a hash, and the text is blanked on forget (the one allowed
  change to an append-only row), (c) the ledger never stores text.
  **Decided: (b)**, no time-based retention for now. Forget does not reach
  two other copies: the stored briefings (what the model was sent, kept as
  the audit record, `db/schema/agent-visibility.ts:39`) and Mem0's own history
  of an updated memory and its project event feed. The forget confirmation
  names them, plus the other store's copy it also removes and the linked
  memories `delete_linked` would take with it. Scrubbing briefings on forget is a separate
  decision, not in this plan.
- **Q3. Routing memory.** First decided (b), always built-in; superseded on
  23.09: Filip decided to **remove routing memory**. The agent and the
  repository selection already learn from the repository work scope record,
  and label-to-repository hints duplicate it. Stage 10 removes the code, the
  `ENABLE_REPO_ROUTING_MEMORY` setting and its documents (none on
  production). A sensible successor (showing the selector similar past
  tickets and the repositories their finished work scope used) belongs to
  repository selection, not to memory, and is out of this plan.
- **Q4. Recall events in the same ledger as writes.** (a) one `memory_events`
  table for recall reports and writes (one timeline per run); (b) writes only
  in the table, recall report in the briefing index next to
  `repositoryContext.leftOutCount`. **Decided: (a).** Stage 3 depends on it.

### Decided after the second review (23.09, Filip accepted both recommendations)

- **Q5. Delete the Mem0 notebook copies after the sweep?** (a) keep them in
  Mem0 forever; (b) delete them in stage 11 after the sweep shows every one
  imported and a dry run lists them. **Decided: (b).** They duplicate
  built-in and hold human decisions in a store the product no longer lists.
  Superseded by Q14: Mem0 is wiped after 6a instead.
- **Q6. Widen the integration pin contract with the Mem0 identity**
  (`packages/contracts`, optional `{orgId, projectId}` on the memory pin
  entry). (a) yes, as D4 describes; (b) no, pin only the integration and
  accept that a key for another Mem0 project mixes one run across projects.
  **Decided: (a).**

### Decided on 25.09 (Filip accepted the recommendations)

- **Q11.** Entry state lives in a new table in migration 0074 (0073 was
  taken on main on 25.09), keyed by a
  stable entry key with the text hash as a movable alias (quality design,
  Decision 1).
- **Q12.** Learning lands only when the work is accepted: proposals wait for
  the PR of that repository to merge, external or flagged runs and runs
  without a PR wait for a human, a PR closed unmerged teaches nothing
  (Decision 2). This removes today's immediate learning.
- **Q13.** Codex gets the area upfront until a probe proves its hooks; hook
  trust is never bypassed (Decision 3).
- **Q14.** Wipe production Mem0 instead of migrating it. Right after 6a
  merges, every memory Mem0 holds today (facts, lessons and notebooks) is
  forgotten through the product's own forget (MCP `memory_forget` or the
  dashboard), so each removal is recorded in the ledger. Production held four
  documents on 23.09, so the history is worth less than the code that would
  carry it. What leaves scope: the D9 batch sweep and its owner-only route,
  the legacy Mem0 notebook read in 1b, the stage 11 sweep gate, Q5 (nothing
  is left to delete), E35 (no legacy immutable entry survives) and E37.
  Stage 1b still sends new notebooks to built-in only, so nothing new lands
  in Mem0 before the wipe. The wipe runs from Filip's session or the
  advisor's MCP login, never from a run.

## Open to the executors

- Names inside the module and the port (the split in D2 is fixed, the words
  are not).
- The exact query recipe (fields, length cap), `top_k`, `threshold`, and how
  derived entries are kept in a ranked recall, decided after the live Mem0
  probe.
- The caveat text telling the agent memory was unavailable or partial.
- The Memory card and `/memory` layout, states and copy, following
  `DESIGN.md` and neighbouring cards (`RunAnalysisReportCard`, `RepositoriesPanel`).
- How `store_changed` is produced (written at run start when the pin differs
  from the previous run's, or derived by the reader).
- Whether `/memory` search is a text filter over the ledger or also over
  current documents.
- Which edge cases get a unit test versus a route-level test, as long as every
  row of the edge-case map has one or a named production observation.

## Seams and test decisions

| Seam | What we observe through it | Prior art |
|---|---|---|
| Memory module public entry (`memory/index.ts`) | Given a store fake and a run context: what the prompt receives, what the ledger records, what the store is asked to apply | `memory-runtime.ts` answer and budget handling (`:350-393`) |
| Memory store port v2 + conformance suite | Any store passes the same behaviour table: recall within limit, held complete, apply outcomes per item, forget one entry, refusals typed | `integrations/sdk/conformance.ts` for other capabilities |
| Existing `"use step"` functions (unchanged names) | Same inputs give the same results as before, plus optional fields; characterization tests guard the move | `memory-steps.test.ts`, `repo-memory-steps.test.ts` (direct step calls, mocked sandbox) |
| Ledger repository (pglite) | Rows appended per event, one statement per call, redacted text, forget blanks text | `db/repositories/memory.ts` tests on pglite (`db/test-db.ts:119-129`) |
| Worker routes and MCP tools | Same answers on `GET /api/v1/memory*`, run memory endpoint, and MCP tools | `routes/api/v1/memory.test.ts`, `mcp/tools/memory.test.ts` (InMemoryTransport) |
| Dashboard screens | Render states from DTO fixtures; then production in the browser | `apps/dashboard` `node:test` + `react-test-renderer`, fixture worker (`fixtures.ts:526`) |
| Live Mem0 | add, search, update, forget on a probe `app_id` | none; stage 5 creates the evidence |

TDD `yes` for the module, the port, the ledger, the transitions and the read
APIs (their seams have prior art). The outer loop is the route or step level
test on pglite; the repo has no browser e2e harness for the dashboard, and the
convention is render tests plus a production browser check (not a question: it
is the house pattern, recorded in Assumptions).

## Edge-case map: store transitions and failures

| # | State | Agent gets | Human sees | Proven by |
|---|---|---|---|---|
| E1 | Mem0 connected first time, Mem0 empty, built-in holds entries | No facts or lessons, caveat says memory is empty for these repos; notebook unaffected | `/memory`: Mem0 active, 0 entries; built-in inactive, N entries, "Copy to Mem0" | route test (production Mem0 is not empty, so not observable there) |
| E2 | Mem0 active only through `AIW_MEM0_API_KEY`, no row | Mem0 memory | Store panel says "from environment" | service test |
| E3 | Key rejected (401/403) | No facts; caveat "memory unavailable: key rejected"; notebook works | Run card: unavailable, reason; store status red with last error | step test with fake store |
| E4 | Quota spent (413) or rate limited (429) | As E3, reason quota | Run card lists the learned items that could not be stored | step test |
| E5 | Mem0 fails after recall succeeded, before distill | Recall as normal | Card: recalled ok, learning unavailable with lost items | step test |
| E6 | Mem0 disabled mid-run | Remaining memory calls unavailable (`store_disabled`); notebook works | Card says so; `/memory` timeline shows the switch | module test |
| E7 | Mem0 disconnected (key erased) | As E6 | `/memory`: Mem0 entries remain in the Mem0 account, unreachable here | route test |
| E8 | Two memory stores enabled | No facts or lessons (ambiguous refusal kept, pinned as such at run start); notebook works | `/memory` names both and says disable one | module test of pin resolution with two stores |
| E9 | Back to built-in after weeks on Mem0 | Built-in's pre-switch entries | `/memory`: built-in active with entry ages; Mem0 inactive, readable, "Copy to built-in" | route test + production |
| E10 | Run suspended across a switch | Its start store; unavailable if that store is now disabled | Card shows pinned store | module test |
| E11 | Run spanning the cut-over deploy | Stored results replay; later steps new code, unpinned (live) | Nothing new for that run | production: a def 14 run parked awaiting a human before the 6a merge, resumed after, card and completion recorded |
| E12 | Notebook over 256 KiB | Truncated notebook with marker | Ledger `notebook_truncated` | step test |
| E13 | Learned item too long, platform path, URL, absent file | Not stored | Ledger `rejected` with reason and text | characterization + module test |
| E14 | Secret in a learned item or in the query | Redacted text | Ledger `redacted`; Mem0 never receives the secret | module test |
| E15 | Value became a known secret after storage | Scrubbed on recall | `/memory` shows it scrubbed; forget removes it from the store | module test |
| E16 | Two runs write the same repo | Both facts survive (built-in retries on version; Mem0 may duplicate, core dedupes on next held) | Ledger shows both runs; `duplicate` rows when collapsed | pglite repository test with interleaved held and apply; Mem0 adapter test with two concurrent applies including a cap removal |
| E17 | Cap reached (40 facts) | Oldest learned entry evicted, derived never | Ledger `removed reason=cap` | module test |
| E18 | Mem0 merges or supersedes our memory on its side | Entry missing or replaced | Owed lookup (Dream vs `infer:false`/`immutable`); if it applies, recall drops `replaced_by` entries and the ledger says so | stage 5 probe |
| E19 | Admin forgets an entry while a run is learning | The run may learn it again | Ledger shows forget then re-add, with runs | route test |
| E20 | Copy between stores run twice | Nothing new | Second preview says 0 to copy | route test |
| E21 | Empty ticket text | List-based recall, `ranked:false` | Card says "not ranked: no ticket text" | module test |
| E22 | Budget exceeded | Entries in rank order until the budget | Card: "3 left out (budget)", with the entries | module test |
| E23 | Preview deployment | Shares the production DB and stored key | Nothing new; preview is read-only for us | read-only observation of preview `/health` and memory status |
| E24 | Entry held but search gives it no score | Placed after scored entries, still eligible | Card: `not_ranked` next to it | module test with a store fake returning a partial ranking |
| E25 | Notebook in Mem0 from before the cut-over, none in built-in | The Mem0 notebook, moved once | Ledger `imported` for that ticket | step test + pre-merge read-only count |
| E26 | Ledger insert fails (NUL, DB blip) | Memory exactly as without the failure | Pino line with run id; card shows "record incomplete" | module test with a throwing ledger, recall and distill |
| E27 | Mem0 key swapped to another Mem0 project | Pinned runs: unavailable (`store_changed`); new runs: the new project | `/memory` timeline: store changed; copy offered | module test on pin comparison |
| E28 | Memory off, run failed, not published, budget spent | No learning | Card says which gate stopped learning | route test per gate |
| E29 | Fact refuted on Mem0 while built-in was inactive, then switch back | Built-in's stale fact until the admin applies the refutation | Copy preview lists "K refuted on the other store" | route test |
| E30 | Pinned runs write to the store that just became inactive | Their writes land there | Copy preview counts "N written after the switch" | route test |
| E31 | Forget an entry that was also sent in briefings or updated in Mem0 | Gone from the store and the ledger text | Confirmation names the copies it cannot reach | render test + stage 5 lookup |
| E32 | `/memory` cleanup while facts live in Mem0 | Notebooks untouched | Built-in panel says it always serves notebooks | render test with notebooks present |
| E33 | Mem0 call exceeds the step's time budget | Unavailable for the rest of that step | Ledger `unavailable` reason timeout, duration in the Pino line | module test with a slow fake |
| E34 | Mem0 accepted an add but the entry is not yet searchable | Next recall may miss it | Ledger `added` with "pending" until held sees it | Mem0 adapter HTTP-fixture test + stage 5 probe |
| E35 | Update of a legacy immutable Mem0 entry | The new text | Ledger `updated` via delete plus add, ids chained | stage 5 probe + 6b production |
| E36 | Mem0 merges or supersedes our entries itself | Superseded entries excluded from recall | Ledger `superseded_by_store` | stage 5 probe with near-duplicate and conflicting pairs |
| E37 | Human decision in a Mem0 notebook while built-in holds an older notebook | Both, merged, newer first | Ledger `imported` for the ticket | step test (1b) + sweep dry run |
| E38 | Distill returns N claims and M contradictions | Nothing to the agent | Exactly N+M ledger rows, each with an outcome | step test (conservation) |

## Out of scope

- Lessons from failed runs (distill runs only after a successful, published
  run, `agent-workflow.ts:5163-5170`). Worth a product decision later; it
  costs model calls and could teach wrong lessons.
- A chooser for two enabled memory stores (E8 keeps the refusal).
- Pattern-based secret detection (today exact known values only).
- Changing the `ENABLE_REPO_MEMORY` default for new installs.
- Moving recall to once per run (changes the step sequence, needs a drain).
- Re-applying items lost to an unavailable store (the ledger keeps them, so a
  later "retry" action is possible).

## Assumptions

- A1. `fix/ticket-notebook-persist` merged (13:01, live). Its known issue (a
  checkout copy can overwrite the stored notebook, because hydrate still
  writes only to the root) is now production behaviour; stage 1b checks it
  and fixes it if real. `feat/memory-store-visibility` has no commit, remote
  or PR: stage 7 absorbs its work (provider field, store panel data) and
  stage 9 its UI, fixing its "routing filed under Notebooks" bug; the local
  branch is closed after its owner is told.
- A2. Changing optional input fields of an existing step call does not break
  replay (only step ids and the call sequence do). Owed lookup in stage 6
  against the installed `@workflow/core`.
- A3. The dashboard has no browser e2e harness; UI stages prove behaviour with
  render tests and a production browser check. Adding Playwright is not part
  of this plan.
- A4. Superseded by D9 and the production evidence: Mem0 already holds
  notebooks.
- A5. Live Mem0 evidence is produced in a separate Mem0 probe project whose
  key Filip supplies (executors never read the stored production key), with
  probe-only `user_id` values so Mem0's own merging on add cannot touch
  production subjects. Probe data is deleted after.
- A8. What a revert strands. Reverting 6a: notebooks written to built-in while
  Mem0 was active are not hydrated by v1 (v1 reads the active store); ledger
  rows stay but nothing new is written. Reverting 6b: recall goes back to
  stored order; updated facts stay as their new text (built-in keeps v1's
  format, so nothing is misread). Forward fixes are preferred to reverts
  after 6a has been live for more than a day.
- A6. The Mem0 plan's retrieval quota is unknown. One search per prompt build
  is cheaper than today's list calls, but whether list calls count as
  retrievals is an owed lookup.
- A7. Toggling the store on production for the final proof is done from
  Filip's dashboard session, announced beforehand, in a quiet window.

## Library facts and what they came from

Mem0 Platform REST (docs read 23.09 through ctx7 `/websites/mem0_ai` and
docs.mem0.ai; OpenAPI at `mem0ai/mem0` f8082a73). The repo calls the REST API
with `ctx.http`; the `mem0ai` npm SDK (3.2.0) is not used and should not be,
because it bypasses `ctx.http` redaction, time budget and retry policy.

- Add `POST /v3/memories/add/`. The OpenAPI says a 200 is "queued; returns an
  event identifier", while the direct-import example returns ids with
  `SUCCEEDED`: the adapter handles both and records when an entry is not yet
  searchable. `immutable` ("excluding them from future update/consolidation")
  is gone from both SDKs, still in REST. A PUT on an immutable memory is
  rejected; the documented path is delete and re-add. Every memory v1 wrote
  on production is immutable (`integrations/mem0/client.ts:213-214`).
- Dream Supersede and Merge are always on and run during add. Merged
  memories are hidden from search and list by default and v3 has no include
  flag; superseded memories are returned with `replaced_by`. Whether they act
  on `infer:false` or immutable memories is unresolved.
- DELETE takes `delete_linked` (default false): true also deletes the older
  memories this one superseded. History keeps a DELETE event. A project event
  feed `GET /v1/events/` exists.
- `GET /v1/ping/` returns `{status, org_id, project_id, user_email}`: the
  identity used for the pin (D4).
- No 429 or quota response is documented; the Python SDK maps 413 to quota
  and 429 to rate limit; error bodies are `{detail}`. ADD is limited to
  1000/min.
- Search `threshold` 0 disables filtering; `top_k` 1 to 1000; `rerank` only
  changes order. Whether the full filtered set comes back is unresolved.
- Search `POST /v3/memories/search/`: semantic plus BM25 plus entity scores,
  `top_k` default 10, `threshold` default 0.1, `rerank` default false; entity
  ids only inside `filters` (top level gives 400); `user_id: {in: […]}`,
  AND/OR/NOT supported; metadata filters eq/ne/contains only; `keywords`
  filter on search returns 500 (MEM-5746).
- List `POST /v3/memories/` paginated, `page_size` max 200, supports `fields`.
- Update `PUT /v1/memories/{id}/` (`text`, `metadata`, `expiration_date`);
  history `GET /v1/memories/{id}/history/`; batch `PUT`/`DELETE /v1/batch/`
  up to 1000 ids.
- "agent_id null for user messages" applies only to `infer:true`; with
  `infer:false` both ids are stored. Confirmed by production recall.
- Quotas: Hobby 1k retrievals/month, Starter 5k, Pro 50k.

Owed lookups (go verbatim into the stage briefs under DOCS FIRST):
- Stage 5: what `immutable:true` does today, whether `PUT` works on an
  immutable memory, whether Dream touches `infer:false` or `immutable`
  memories; whether search with `threshold` 0 and a large `top_k` returns the
  complete filtered set; max memory size and max query length; whether list
  counts as a retrieval; the exact status for quota spent and rate limits;
  whether DELETE clears a memory's history; how Test identifies the Mem0
  organisation and project for the pin.
- Stage 6: WDK replay tolerance for changed step arguments (`@workflow/core`
  installed version, `step.js`).
- Stage 3: drizzle-kit version in the repo and how it generates an
  append-only table with the indexes needed, offline.
- Stage 9: none expected beyond the repo's React and Next versions for any
  new component API used.

## Hard rules for every stage

- Heavy commands only through `lanes/heavy.sh`, one at a time; never the full
  worker suite locally; never `pnpm build` in `apps/worker`; never
  `db:migrate` or anything reaching `DATABASE_URL`.
- Own worktree per executor under `lanes/`; `/usr/bin/git`; no stash or reset
  in shared worktrees.
- No local worker or dashboard server; preview and demo are read-only.
- Each stage ships a `changelog/unreleased/` entry, merges with
  `gh pr merge --merge` on green CI, then `/health` is checked on production.
- Every merge must be safe alone: main deploys production.
- Any stage touching `engine/` runs
  `src/engine/workflow-import-boundary.test.ts` and
  `src/engine/step-registration-coverage.test.ts`, and shows with
  `/usr/bin/git diff` that no `"use step"` was added, removed or renamed and no
  step call was added or removed.
- New schemas in `memory/**`, routes and `services/memory*` use only APIs
  common to zod 3 and 4 and are either added to `vitest.zod4.config.ts` or
  live in `packages/contracts` (covered by `test:packages:zod4`); stage 3 adds
  `memory/**` to the paths of `.claude/rules/zod-bundle.md`.
- Commits `type(scope): message` in one line plus the `Co-Authored-By`
  trailer; PR bodies end with the Claude Code line; no em or en dashes.

`H=/Users/filip/Desktop/Blazity/ai-workflow/lanes/heavy.sh`, `W=apps/worker`.

## Execution table (consolidated 25.09, binding order)

The stage rows below and in `2026-09-23-memory-quality-and-routing.md`
("Stages added or changed", read with its "Advisor resolutions, 25.09") are
the specification of each stage. This table is the order and the gate. Gates
follow the process in force since 24.09: `evidence` (the executor's DoD is
the gate), `review` (one reviewer pass), `review+skeptic` (skeptic scenarios
at stage start, reviewer and skeptic walk at the gate); one fix round at most.

| Wave | Stage | Gate | Starts after | Merge note |
|---|---|---|---|---|
| 1 | 1 characterization | evidence | now | tests only |
| 1 | 2 port v2 + conformance | review | now | additive SDK |
| 1 | 3 ledger + entry state (0073) | review+skeptic | now | new tables on deploy |
| 1 | U UX spec revision (docs) | evidence | now | docs only |
| 2 | 1b notebook built-in only | review | 1 merged | stops Mem0 notebooks growing |
| 2 | 4 module + built-in v2 | review | 1, 2, 3 merged | unwired |
| 2 | 5 Mem0 v2 + live probe | review | 1, 2 merged; probe key from Filip | unwired |
| 2 | 7 reads + MCP (absorbs store visibility) | review | 3 merged | merges before 6a |
| 3 | 6a pin, ledger writes | review+skeptic | 1b, 4, 5, 7 merged | first run-path change; parked run; Mem0 wiped right after merge (Q14) |
| 3 | 4b policy module | review | 4 merged | unwired |
| 3 | 4c memory kit + CLI probe | review | 4b merged | unwired |
| 4 | 6b placement, ranking, updates, org proposals | review | 6a proven, 3, 4b merged | |
| 4 | 7b human fixes, pins, inbox | review | 4b, 6b merged | |
| 4 | 8 copy between stores, switch timeline | review+skeptic | 6a, 7 merged | |
| 5 | 6c pull first | review+skeptic | 6b proven, 4c, 7b merged | |
| 5 | 6d collection per invocation | review | 6c merged | |
| 5 | 6e learning after merge | review+skeptic | 6d merged | removes immediate learning (Q12) |
| 6 | 9 dashboard (9a run page, 9b /memory and integrations) | review | 7, 7b, 8, U merged | Filip looks at it live |
| 6 | 10 remove routing and org switch | review | 1, 6a, 6b, 9 merged | |
| 7 | 11 remove v1 and legacy paths | evidence | 6c, 6d, 6e proven, 10 merged, Mem0 wiped (Q14) | |
| 7 | 12 docs, red team, production proof | red team + branch review | everything | |

Live agents at most 4 at a time. Decisions Q1 to Q14 are final; the stage rows below are read with Q14 (no sweep, no legacy notebook read, no E35 or E37).

## Stages

Tier: every role on Opus 5.5 (one model); `worker` agents only for delegated
mechanical subsets. `ENGINE CHECKS` means the two boundary tests plus the
`/usr/bin/git diff` proof from the hard rules.

| # | Stage (outcome) | Seam | File scope | Tier | Autonomy | Skeptic | TDD | Delegation | DoD |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Today's memory behaviour is pinned by tests, and MCP reads of production memory are recorded | Existing steps and adapters | New `*.characterization.test.ts` beside `engine/steps/memory-steps.ts`, `repo-memory-steps.ts`, `repo-seed-steps.ts`, `write-human-decisions-memory.ts`, `engine/support/memory-runtime.ts`, `memory/repo-memory.ts`, `integrations/mem0/memory.ts`; `lanes/qa-memory-baseline-20260923.md` (exists, extend) | Opus 5.5 | tight | no | no | yes (fixture builders) | `cd $W && $H pnpm exec vitest run` on every new characterization file green, and `cd integrations/mem0 && $H pnpm test` green; each file sabotaged once and seen red (recorded); covers recall order and budgets, cut markers, distill filters and caps, the three merge outcomes (`memory/repo-memory.ts:151-215`), promotion, hydrate then human decisions then persist, per-step provider resolution (marked "changes in 6a"), teardown gates, the bare-array result branch, v1 provenance suffix parsing, repo selection with routing memory absent (the path it takes after removal), human-decisions content and placement, and the Mem0 v1 adapter's skip, refute, cap and notebook replace on the fake HTTP |
| 1b | Notebooks stop going to Mem0 and no human decision is shadowed | Existing notebook steps (thin change) | `engine/steps/memory-steps.ts`, `engine/support/memory-runtime.ts` (notebook resolution only), their tests | Opus 5.5 | tight | yes | yes | no | After stage 1 merges. Step tests green for: hydrate and persist always built-in; legacy Mem0 notebook read while built-in has none; both present merged newer first (E37); Mem0 leg failure reports `recalled:false` and teardown withholds; the checkout-overwrite issue from A1 checked and fixed if real. ENGINE CHECKS green. After merge on production: one def 14 ticket run leaves its notebook in built-in (`memory_list` shows `ai-workflow/memory/<KEY>.md` under a built-in label or the DB-free route) and no new `notebook/*` appears in Mem0 |
| 2 | A memory store has a v2 port and a conformance suite any store must pass | Port v2 + conformance | `integrations/sdk/memory.ts` (additive v2), `integrations/sdk/memory-conformance.ts`, `integrations/sdk/memory-conformance.test.ts`, `docs/adr/ADR-010-integrations.md` (amendment) | Opus 5.5 | tight | yes | yes | no | `cd integrations/sdk && $H pnpm run typecheck` and `$H node --import tsx --test memory-conformance.test.ts` green against an in-memory reference store; the suite includes complete recall, complete held, outcome carries the resulting id, forget by text hash leaves the rest, a consolidating store declares it; `git diff` of `memory.ts` shows additions only |
| 3 | Every memory event can be recorded and read back, redacted, and blanked on forget | Ledger repository | `db/memory-events-schema.ts`, `db/repositories/memory-events.ts` (+ test), generated `apps/worker/drizzle/0073_*.sql` and snapshot, `memory/ledger/**`, `.claude/rules/zod-bundle.md` (paths) | Opus 5.5 | tight | yes | yes | no | `cd $W && $H pnpm exec vitest run src/db/repositories/memory-events.test.ts src/memory/ledger` green, including NUL stripping, re-redaction on read, blank-on-forget by text hash across text, previous text and detail items, one statement per append; migration generated offline and additive only; after merge `/health` shows the commit and `/runs` still lists |
| 4 | The memory module decides everything: recall with budgets and report, learning plan with dedup, updates, caps, redaction, conservation, consolidation reconciliation, pin comparison, best-effort ledger, structured logs | Module entry | `memory/**` except `memory/ledger/**`, `memory/repo-routing.ts` (removed in stage 10) and stage 1's characterization files; boundary rule in `scripts/gates/` | Opus 5.5 | tight | yes | yes | yes (moving pure helpers with their tests) | After stage 1 merges. `cd $W && $H pnpm exec vitest run src/memory` plus every stage 1 characterization file green; built-in store passes stage 2 conformance; throwing-ledger (E26), slow-store (E33) and conservation (E38) tests green; a test captures the logger and asserts one structured line per store call; ENGINE CHECKS green; module not wired, so no production change |
| 5 | Mem0 answers the v2 port correctly under its real behaviour, proven on live Mem0 | Port v2 (Mem0 adapter) | `integrations/mem0/**` (adapter, identity from ping, status mapping, probe script) | Opus 5.5 | tight | yes | yes | no | After stage 1 merges. `cd integrations/mem0 && $H pnpm test` green including stage 2 conformance on the fake and HTTP-fixture tests for 401/403 key, 413 quota, 429 rate limit, other status unavailable with status recorded, queued vs synchronous add, `replaced_by`, `delete_linked`. Probe in the Mem0 probe project with Filip's probe key and probe-only `user_id`s: add (record response shape and time to searchable), search by query with scores, near-duplicate and conflicting pairs with and without `immutable` (list, search and history visibility of merged and superseded), update of an immutable entry (rejected, then delete plus add), forget with `delete_linked`, a bad key giving a live 401; report `lanes/qa-mem0-probe-20260923.md` decides `immutable` for new writes; probe data deleted |
| 6a | Runs keep their store, every memory event and skip reason is on record, Mem0 notebooks are swept, the agent is told when memory is missing; recall content unchanged | Existing steps (thin shells) | `engine/steps/repo-seed-steps.ts`, `engine/steps/run-start-settings.ts`, `engine/support/memory-runtime.ts`, `services/integrations/impact.ts`, the notebook sweep service and owner-only route under `services/memory-sweep/**` and `routes/api/v1/memory/sweep*`, memory call sites in `engine/agent-workflow.ts` and `engine/blocks/prepare-workspace/execute.ts`, `packages/prompts/effective-prompt.ts` (caveat line), the write half of `engine/steps/repo-memory-steps.ts`, pin type in `packages/contracts` (Q6) | Opus 5.5 | tight | yes | yes | no | After 1b, 4, 5 and 7. Characterization rows marked "changes in 6a" rewritten and seen red first, the rest green; conservation test green; ENGINE CHECKS green; `$H pnpm run verify:changed` green; disable preview counts memory-pinned runs. Before merge: a def 14 run parked awaiting a human (E11); the sweep dry run lists every Mem0 notebook. After merge on production: the parked run resumes and completes with its card; the sweep runs from Filip's session and every Mem0 notebook has an `imported` row; one def 14 ticket run shows `recalled` and write rows through the stage 7 API |
| 6b | Recall is ordered by relevance to the ticket and facts are updated in place | Existing steps (thin shells) | the recall half of `engine/steps/repo-memory-steps.ts`, distill prompt and schema (update pairs, `reviewNotes` finally passed, a scope label per claim that replaces the two-repositories promotion at `repo-memory-steps.ts:1078-1178` with org proposals per D10), the recall and distill call sites in `engine/agent-workflow.ts` | Opus 5.5 | tight | yes | yes | no | After 6a is proven on production. Module and step tests green for E21, E22, E24, E35 and update chains; ENGINE CHECKS green; production: ticket B's `recalled` row shows `ranked:true`, a score per entry and the Mem0 search call in its Pino line; an update of a legacy immutable fact shows previous and new text |
| 7 | People and agents can read the ledger: run memory report with skip reasons and gaps, document history, search, store status, per-entry forget by text hash, inactive store (facts and lessons only), legacy notebooks | Routes and MCP tools | `services/memory/**`, `routes/api/v1/memory*` (except sweep and transfer), `routes/api/v1/runs/[id]/memory*`, `mcp/tools/memory.ts`, `mcp/tool-catalog.ts`, `mcp/contracts/mcp-contract.json`, memory DTOs in `packages/contracts/api.ts`; absorbs the uncommitted `feat/memory-store-visibility` work | Opus 5.5 | tight | yes | yes | no | Merges before 6a. `cd $W && $H pnpm exec vitest run src/routes/api/v1/memory.test.ts src/mcp/tools/memory.test.ts` plus new route tests green (E28 per gate, E31, E32, store status with built-in present, last error with reason and last success, legacy notebook listing, MCP notebook description fixed); `$H pnpm run mcp:contract:check` green; a test seeds one ledger and compares every dashboard read with its MCP tool |
| 8 | An admin can copy entries between stores on purpose with an honest preview, and every switch appears on the timeline with its actor | Module entry (transfer) + routes + MCP | `services/memory-transfer/**`, `routes/api/v1/memory/transfer*`, `store_changed` writes in `services/integrations/authoring.ts`, transfer reads in `mcp/tools/memory-transfer.ts` and its catalog and contract entries, disable-preview wording in `apps/dashboard/lib/integrations/presentation.ts` | Opus 5.5 | tight | yes | yes | no | Route tests green: preview equals result; apply recomputes against a fresh held set and refuses with a new preview when it differs; repeat copy gives 0; refuted-elsewhere list with the ledger start date (E29); written-after-switch count (E30); notebooks never counted; non-admin refused; store unavailable; toggling Mem0 off then on writes two `store_changed` rows with the admin as actor; MCP reads of preview and status match the route; `mcp:contract:check` green; disable preview text matches D4 |
| 9 | The run page has a Memory card and `/memory` shows history, search, the store panel, folders and copy, readable at a glance | Dashboard screens | per the UX spec `docs/plans/2026-09-23-memory-package-ux.md` (split into 9a run page and 9b `/memory` and integrations when the spec lands) | Opus 5.5 | open | yes | no | yes (fixture DTOs) | Per the UX spec's "What the UI stages must prove": render tests for every state green; production in the browser at desktop and phone width on real runs |
| 10 | Routing memory is gone and human decisions go through the notebook module | Module entry | `memory/repo-routing.ts` (+ test, deleted), the routing reads and writes in `engine/pre-sandbox/steps/repo-selection.ts` (live file; `pre-sandbox/steps/repo-selection.ts` is a re-export), `ENABLE_REPO_ROUTING_MEMORY` and `ENABLE_ORG_MEMORY_PROMOTION` in `packages/contracts/settings-registry.ts` (their `/memory` switches are dropped by stage 9, which owns that screen), `engine/steps/write-human-decisions-memory.ts` (body only), `engine/support/human-decisions-memory.ts` | Opus 5.5 | tight | yes | yes | no | After stage 1 merges, 6a and 6b are live and stage 9 has merged. `cd $W && $H pnpm exec vitest run src/pre-sandbox/steps/repo-selection.test.ts src/sandbox/write-human-decisions-memory.test.ts src/memory` green and the output lists all three; repo selection falls through exactly as it did with routing off (stage 1 characterization unchanged); ENGINE CHECKS green; `rg -n "repo-routing|ENABLE_REPO_ROUTING_MEMORY|ENABLE_ORG_MEMORY_PROMOTION" apps packages integrations` hits nothing; settings screen no longer shows the switch; human decisions read the trusted manifest; step signatures unchanged |
| 11 | The old port, the legacy notebook read and duplicates are gone | Port v2 only | `integrations/sdk/memory.ts` (v1 removal), v1 remnants in `integrations/mem0/**`, `memory/store.ts`, `services/publication/human-decisions-memory.ts` (+ test), the legacy Mem0 notebook read, duplicated notebook path constants | Opus 5.5 | tight | no | no | yes (constant sweep) | Only after 6b is proven and every Mem0 notebook has an `imported` row (and, per Q5, the copies are deleted after a dry run). `$H pnpm run typecheck` green; ENGINE CHECKS green; `rg -n "ai-workflow/memory|notebook/" apps/worker/src integrations` hits only the one constant, the Mem0 mapping and tests; conformance green |
| 12 | One document explains memory; production proves the whole path | Whole feature | `docs/architecture/memory.md`, memory section of `docs/architecture/integrations.md` (guide: writing a memory store), `CONTEXT.md` vocabulary, `SETUP.md` Agent memory, `docs/index.md`, `lanes/report-memory-final.md` | Opus 5.5 | open | yes (red team) | no | no | The document has a flow diagram with code links and states the ADR-001 position and where the prompt section is rendered; the guide covers port, conformance, refusal mapping and registration; docs-status green. Red team as a human on the dashboard and as an agent through MCP, including a timed "why didn't it remember X" drill on a real run using only the card, `/memory` search and MCP (time recorded). Production: on a fixture seeded with facts on at least two topics, ticket A teaches a fact, ticket B's card shows `ranked:true`, scores, and B's topic above the unrelated one; switch Mem0 to built-in, run one ticket whose card shows built-in, switch back; both switches on `/memory` with the admin as actor. Every E-row has a test or an observation listed in `lanes/qa-memory-final-*.md`. `lanes/report-memory-final.md` in Polish: what was wrong, what changed, how it works, what is left, decisions waiting |

## Order, parallelism and merge safety

- Stages 1, 2, 3 run in parallel (disjoint files). None changes production
  behaviour; stage 3 adds a table on deploy.
- 1b starts as soon as stage 1 merges and merges quickly: every day of delay
  adds Mem0 notebooks.
- Stages 4 and 5 start after stage 1 has merged and stage 2's gate (the port
  is frozen); stage 4 also needs stage 3's ledger interface. Both land
  unwired.
- Stage 7 runs after stage 3 and merges before 6a, so 6a's production proof
  has a reader.
- 6a starts after 1b, 4, 5 and 7. It is the first merge that changes the run
  path beyond the notebook: merge in a quiet window with a parked run, run one
  ticket, read its ledger, then wipe Mem0 (Q14). 6b follows only after 6a is proven.
- 6a and 6b share `repo-memory-steps.ts` and `agent-workflow.ts` by halves;
  they never run at the same time.
- Stage 8 after 6a and 7. Stage 9 after 7 and 8 and the UX spec. Stage 10
  after stage 1, 6a, 6b and 9 (6b replaces the promotion code; stage 9 drops
  both switches from `/memory`). Stage 11 after 6b is proven, 10 is merged and
  Mem0 is wiped. Stage 12 last.
- Drain: none planned (D7). Verified against `@workflow/core` 4.8.0: replay
  matches by correlation id and step name only, so optional new inputs and
  result fields are safe. A stage that breaks D7 stops and asks.

## Pre-mortem record

Skeptic pre-mortem on 23.09 returned REJECT with ten findings; each was
triaged:

1. Blocker, ranked search would silently drop facts a list gives today, with
   the card saying "left out 0". **Design fixed:** D2 and D5 now require
   recall to return the complete set; relevance only orders; `not_ranked`
   reason; E24.
2. Major, notebooks persisted to Mem0 by the in-flight fix would be lost at
   the cut-over. **Design fixed:** D9 move-on-read, pre-merge count, removal in
   stage 11; A4, E25.
3. Major, the cut-over was too big and its revert strands data or misreads
   the built-in format. **Design fixed:** split into 6a and 6b; built-in keeps
   v1's format with text-derived ids; A8 states what each revert strands.
4. Major, a failing ledger insert would erase the memory it records.
   **Design fixed:** best-effort rule in D3, NUL stripping, E26.
5. Major, a key swap to another Mem0 project fooled the pin and the disable
   preview under-counted. **Design fixed:** pin through `integration_pins`
   with project identity (D4), `impact.ts` in 6a, E27.
6. Major, skipped learning looked like "learned nothing". **Design fixed:**
   D3 paragraph on gate reasons, E28, stage 7 tests per gate.
7. Major, forget does not reach briefings or Mem0 history, later secrets
   showed in clear, built-in ids changed on update. **Design fixed** for
   re-redaction on read and id chaining in the ledger; **decided by Filip** with
   Q2 on 23.09 (forget does not scrub briefings; the confirmation names the
   copies). E31.
8. Major, switching back revived refuted facts and the copy preview did not
   match the result. **Design fixed:** Q1 preview through the apply plan,
   refuted-elsewhere list, written-after-switch count; E29, E30.
9. Major, built-in is never inactive and a cleanup could erase notebooks.
   **Design fixed:** D8, E32.
10. Major, sequencing and DoD gaps. **Design fixed:** stage 3 merge waited for
    Q2 and Q4 (answered 23.09); stage 4 DoD runs the characterization tests; stage 7 merges
    before 6a; stage 10 test paths corrected and must list all three files;
    stage 5 probe uses a separate project and a key Filip supplies (A5).

Second pass on 23.09, after Filip's answers and with MCP access: production
evidence (`lanes/qa-memory-baseline-20260923.md`), fresh Mem0 docs answers, a
skeptic re-pass and a completeness critic, both REJECT. Resolution:

- Notebooks already in Mem0 and growing (blocker in both): D9 rewritten,
  stage 1b added, sweep in 6a, stage 11 gated on the sweep, Q5 decided by Filip.
- Pin identity cannot come from today's fingerprint: D4 now pings on key save
  and Test, stores `{orgId, projectId}`, compares against it; the contract
  widening was decided by Filip (Q6).
- Mem0 facts contradicted the plan (queued add, Merge hides, superseded
  returned, `delete_linked`, 413 quota, immutable blocks PUT): Library facts,
  D2, D6, stage 5 probe and E33 to E36 updated.
- Distill outcomes the ledger could not express: new events and the
  conservation test (E38).
- Store switches with no run in between were lost: `store_changed` written by
  the admin requests (stage 8 scope).
- Logs, store status and the timed drill had no DoD: D3 logs paragraph, stage
  7 status tests, stage 12 drill.
- Forget reached one id only: forget by text hash across both stores and
  ledger rows.
- Copy preview raced with pinned writes and missed pre-ledger refutations:
  apply recomputes and refuses on difference; preview states the ledger start
  date.
- Ledger gap had no carrier and `memory_unavailable` metadata is overwritten:
  gap detection in the run reader; the observation is retired for the ledger.
- MCP parity for transfer, visibility branch overlap, missing engine checks
  and zod 4 coverage, stage 12 proofs that could pass by chance: stage 7
  absorbs the visibility work, stage 8 gets MCP scope, hard rules and DoDs
  updated, stage 12 DoD rewritten.
- Stage ordering: 4, 5 and 10 start only after stage 1 merges; stage 1 now
  also characterizes human decisions, repo selection without routing memory and the Mem0 v1 adapter. (Routing memory itself was removed by Filip's decision.)
- Proofs that would not prove: E1, E8, E11, E16, E23 changed; E33 to E38 added.
