Status: draft
Last-verified: 2026-09-23

# Agent memory: UX spec

The UX half of [2026-09-23-memory-package.md](./2026-09-23-memory-package.md)
(stage 9, split into 9a run page and 9b `/memory` plus Integrations). It is
the design lead's merge of three competing designs; the judging record is at
the end. Base: `origin/main` at `c8339fb4045757678685578ac9f48e148437594a`.
Paths are under `apps/dashboard/` unless they start with another root.

The product owner's bar (23.09, Polish, paraphrased): memory must read
pleasantly and clearly, and it must be obvious at a glance what memory did and
why. A screen that is correct but that nobody can read counts as a failure.

## Quality bar

"Excellent" here is a list of checks that pass or fail. Stage 9 proves each
one in a render test, in the browser, or both (see "What the UI stages must
prove").

| # | Bar | How it is checked |
|---|---|---|
| Q1 | **Five seconds on a run.** The Memory card names the store, then says what the store held, what the agents got, and what the run learned, in four short lines. Counts come first and problems show as chips. | At 1280 by 800, on a run with no error card and no clarification, the card header and all four beat lines are visible without scrolling. A person who has never seen the card reads the four beats aloud correctly (stage 12 red team). |
| Q2 | **One minute to answer "why didn't it remember X".** From the run page it takes at most three interactions to reach a verdict sentence: open "Search memory for this run", type X, press Enter. | Timed drill in stage 9 on production (rehearsal) and in stage 12 (recorded), under 60 s each. |
| Q3 | **No count without its entries.** Every number on the card and on `/memory` opens the entries it counts. | A render test clicks each count and asserts the matching rows are shown and focused. |
| Q4 | **An unknown is never shown as zero.** A value the worker could not read renders as "unknown" together with the reason. | The DTO types every count as `number \| null`. A render test feeds null and asserts the word "unknown" and the reason, and asserts no "0". |
| Q5 | **Nothing silent.** Every ledger code and every reason has a chip, a tone and a sentence. A code the dashboard does not know shows as the code itself, never as a blank. | An exhaustiveness test over the ledger code list in the vocabulary module, plus a render test with an unknown code. |
| Q6 | **The dashboard and MCP say the same thing.** Both read the same sentences for the same facts. | A route test seeds one ledger and compares every DTO `sentence` and `summary` with the MCP `data.summary` and `data.lines` (extends the stage 7 DoD). |
| Q7 | **Everything named is a link.** A run, ticket, document or entry mentioned on a memory surface is an anchor to it. | A render test counts ticket keys and run ids in the text against anchors. |
| Q8 | **Phone works.** At 390 px: no horizontal scroll, no text wraps one letter per line, and the summary comes before the detail. | The browser JS checks listed under "What the UI stages must prove", each first run against a known-bad page as a positive control. |
| Q9 | **It fits the house.** No raw hex, no primitive reskinned, no new colour role, no orange, and mono only for ids, time, sizes and refs. | `pnpm run gate:ui-primitives` green. `rg '#[0-9A-Fa-f]{3,6}\b'` over new and changed memory files returns nothing. Review against DESIGN.md. |
| Q10 | **Every action shows its effect before it happens.** Forget, copy, disable and disconnect show, before the click, what they will do, what they will not reach, and which runs they touch. The worker computes that text, not the dashboard. | Route tests: the preview equals the result. Render tests: the confirmation names every item the preview returns. |

The people in the plan's "Users and situations", and what each must read
within five seconds of landing:

| Who | Lands on | Must read at once |
|---|---|---|
| Engineer after a run | Run page | The store, "4 of 7 given, 3 left out: budget", "1 learned, 1 not stored" |
| Engineer chasing X | `/memory` search | One verdict chip and sentence per match, scoped to the run |
| Engineer cleaning up | Document detail | The entry's text and who taught it; Forget names every copy it cannot reach |
| Admin connecting Mem0 | `/memory` store panel | "Mem0 serves facts and lessons. Built-in still holds 12 entries runs no longer read." plus Preview copy |
| Admin switching back | Integrations disable preview | How many runs are pinned, split running and waiting, and what they do next |
| Agent through MCP | `runs.memory`, `memory.search` | The same `summary` line the card shows, then one line per item |
| Run in flight during a switch | Run page later | "Kept Mem0. Mem0 was turned off at 14:10; the run went on without facts and lessons." |
| Run while Mem0 is down | Run page | A failure notice with the reason and the items that were lost |

## Principles

1. **A run's memory is told in three beats and a footnote.** *Knew*: what the
   store held for the run's subjects. *Given*: what each prompt got, what was
   left out, and why. *Learned*: what the run changed afterwards. The footnote
   is the notebook. Every surface that talks about one run uses this order.
2. **Counts first, entries one click away.** A sentence leads with numbers,
   the entries sit behind a Disclosure, and each number opens its entries.
3. **One sentence per state, from one vocabulary.** The worker renders every
   sentence from `packages/contracts/memory-vocabulary.ts` and sends it next
   to its code. The UI never writes its own reasons. It takes chip labels and
   tones from the same module.
4. **Unknown is said as unknown.** A null value is shown as "unknown" with its
   reason, never as 0, as an empty list, or as "nothing".
5. **Name the store everywhere.** Each surface says which store it read from:
   Mem0, or built-in. "Memory" alone is never enough.
6. **Problems open themselves.** A Disclosure opens by default only when it
   holds a warn or failed chip. The quiet path stays closed and short.
7. **Show before you act.** Forget, copy, disable and disconnect each show a
   preview computed by the worker, and the action does what the preview
   showed or refuses with a fresh preview.
8. **People by name.** Admins are named, MCP clients by their client name, and
   runs by ticket key with the run id as a secondary ref. Raw ids appear only
   as a fallback, marked as an id.
9. **A subject is its human name.** A repository subject is shown as
   `Blazity/aiw-checks-fixture`, an org as `Org Blazity`, a ticket as
   `AWP-274`. It is never cut to `repo:github:Blazity/a...`. On a narrow
   screen the name wraps after the slash; it is never cut.
10. **Fit DESIGN.md.** A dense operator console: CkCard, CkChip, CkTabs,
    RouteTabs, Modal, Button, Select, Input, CkPagination, Notice,
    LoadFailureNotice, Skeleton. No new colour roles. Orange is not used,
    because on this dashboard it means only "awaiting input". Mariner is
    used only for links, selection and a live run's chip.

## Vocabulary

**Home.** The module `packages/contracts/memory-vocabulary.ts` sits beside the
memory DTOs that stage 7 adds to `packages/contracts/api.ts`. Both the worker
and the dashboard already import `@shared/contracts`.

**What it exports.**
- `MEMORY_EVENT_CODES` and `MEMORY_VERDICT_CODES`, both `as const`.
- `memoryChip(code)`, which returns `{ label, tone }`. The tone is one of
  `neutral`, `success`, `warn`, `failed` or `blocked`.
- `memorySentence(code, params)`.
- The summary pattern functions of the run card and the store panel.
- `formatBytes`, moved here from `lib/agent-visibility/format.ts`, which
  re-exports it. This way the card, the Briefing and MCP print a size the
  same way.

**Who uses it.** The worker fills `sentence` on every row and `summary` on
every report, for the routes and MCP alike. The dashboard shows the DTO's
`sentence` and takes only the chip label and tone from the module.

**Version skew.** The worker and the dashboard deploy separately. A code the
dashboard does not know still shows the worker's sentence, with the code
itself as a neutral chip. This follows `lib/agent-visibility/wording.ts`,
where a value with no words is shown as itself.

**Tone rules.**
- `success`: something was kept.
- `warn`: something the reader should look at, caused by policy, not by a
  fault.
- `failed`: a store failed or refused.
- `neutral`: normal memory life.
- `blocked`: learning did not run on purpose.

**Warn tone first.** CkChip's `warn` tone uses raw hex (`components/ui.tsx:86`).
Stage 9 first adds `--color-warn-bg` and `--color-warn-fg` tokens (DESIGN.md
asks for a semantic token before new use of the yellow warning literal) and
points `warn` at them.

**Placeholders in the sentences.**
- `{run}` renders as the ticket key, or as the short run id when the run has
  no ticket.
- `{actor}` renders as a person's name, an MCP client's name, or "a run".
- `{store}` renders as `Mem0` or `built-in`.
- `{agent}` renders as the block label, for example "Implementation agent".

A row that lists several reasons gives one sentence per reason, in the same
order.

| Code | Chip | Tone | Sentence |
|---|---|---|---|
| **Recall (one `recalled` row per prompt build, with per-entry states)** | | | |
| `recalled` (entry state `sent`) | SENT | neutral | Sent to {agent}. |
| `left_out.budget` | LEFT OUT | warn | Left out of {agent}: the {budget} memory budget was full. |
| `left_out.cap` | LEFT OUT | warn | Left out of {agent}: past the limit of {cap} {kind} per prompt. |
| `left_out.superseded` | LEFT OUT | neutral | Left out: {store} marked it replaced by a newer entry. |
| `not_ranked.no_query` | NOT RANKED | neutral | Not ranked: the ticket has no text to rank by, so entries went in stored order. |
| `not_ranked.no_score` | NOT RANKED | neutral | Not ranked: {store} gave it no score, so it went after the ranked entries. |
| **Learning (after a published run)** | | | |
| `added` | LEARNED | success | Learned by {run}. |
| `added.pending` | LEARNED | success | Learned by {run}. {store} has not made it searchable yet, so the next run may miss it. |
| `updated` | UPDATED | neutral | Changed by {run}. |
| `confirmed` | CONFIRMED | neutral | {run} found it still true. |
| `duplicate` | ALREADY KNOWN | neutral | Already known, so it was kept once. |
| `contradicted.matched` | REFUTED | neutral | {run} found it no longer true. |
| `contradicted.unmatched` | NO MATCH | neutral | {run} said something is no longer true, but no stored entry matched it. |
| `removed.refuted` | REMOVED | neutral | Removed: {run} found it no longer true. |
| `removed.cap` | REMOVED | neutral | Removed to stay under {cap} {kind}: it was the oldest learned entry. |
| `removed.forgotten` | FORGOTTEN | neutral | Forgotten by {actor}. The text is erased from this history. |
| `rejected.too_long` | NOT STORED | warn | Not stored: longer than {max} characters. |
| `rejected.platform_path` | NOT STORED | warn | Not stored: it names an AI Workflow file, not a file of the repository. |
| `rejected.url` | NOT STORED | warn | Not stored: it contains a URL. |
| `rejected.file_absent` | NOT STORED | warn | Not stored: it names {file}, which is not on {branch}. |
| `rejected.self_contradiction` | NOT STORED | warn | Not stored: the run both stated it and said it was no longer true. |
| `rejected.store_refused` | NOT STORED | failed | Not stored: {store} refused it ({status}). |
| `redacted` | REDACTED | warn | Stored with a secret replaced by [redacted]. |
| `superseded_by_store` | MERGED BY STORE | neutral | {store} merged it into another entry on its own. |
| **Notebook (always built-in)** | | | |
| `notebook_saved` | SAVED | success | Notebook saved, {bytes}. |
| `notebook_truncated` | CUT | warn | Notebook saved, cut at the 256 KiB limit; the cut is marked in the text. |
| `notebook_absent` | NONE | neutral | The agent wrote no notebook. |
| `notebook_withheld` | KEPT OLD | warn | Notebook not saved: the run could not read the stored notebook at start, so saving would have overwritten it. The stored one was kept and this run's notes were not. |
| **Store unavailable (recall or learning)** | | | |
| `unavailable.key_rejected` | UNAVAILABLE | failed | {store} rejected the key ({status}). |
| `unavailable.quota` | UNAVAILABLE | failed | {store} quota is spent ({status}). |
| `unavailable.rate_limited` | UNAVAILABLE | failed | {store} asked to slow down ({status}). |
| `unavailable.timeout` | UNAVAILABLE | failed | {store} did not answer within {seconds} s. |
| `unavailable.store_error` | UNAVAILABLE | failed | {store} failed ({status}): {detail}. |
| `unavailable.store_disabled` | UNAVAILABLE | failed | {store} was turned off during this run. From then on the run went on without facts and lessons; it was not stopped. |
| `unavailable.store_changed` | UNAVAILABLE | failed | {store} was replaced during this run. From then on the run went on without facts and lessons; it was not stopped. |
| `unavailable.ambiguous` | UNAVAILABLE | failed | Two memory stores were on, so this run got no facts or lessons. |
| **Copies and switches (actor is a person or the environment)** | | | |
| `imported.transfer` | COPIED | neutral | Copied from {from} by {actor}. |
| `imported.notebook_sweep` | MOVED | neutral | Notebook moved from Mem0 to built-in. |
| `store_changed.enabled` | SWITCHED | neutral | {actor} switched facts and lessons from {from} to {to}. |
| `store_changed.disabled` | SWITCHED | neutral | {actor} turned {from} off; facts and lessons now come from {to}. |
| `store_changed.disconnected` | DISCONNECTED | neutral | {actor} disconnected {from}. Its entries stay in the {from} account, unreachable from here. |
| `store_changed.project` | SWITCHED | neutral | {actor} saved a key for another {store} project ({project}). Runs pinned to the old project lost memory. |
| `store_changed.environment` | SWITCHED | neutral | Facts and lessons moved from {from} to {to} through the environment; no one clicked anything here. |
| **Derived by the reader (never stored as rows)** | | | |
| `skipped.memory_off` | SKIPPED | blocked | Learning skipped: memory was off when this run started. |
| `skipped.run_failed` | SKIPPED | blocked | Learning skipped: memory learns only from successful runs, and this one failed. |
| `skipped.not_published` | SKIPPED | blocked | Learning skipped: this run published nothing. |
| `skipped.budget_spent` | SKIPPED | blocked | Learning skipped: the run had spent its model budget. |
| `record_incomplete` | RECORD INCOMPLETE | warn | Part of this run's memory record is missing. The entries below carry this run's id in {store} but have no record row. |
| `predates_ledger` | NOT RECORDED | neutral | This run started before memory was recorded ({date}). Each agent's Briefing still shows what it was sent. |
| `setting_changed` | SETTING | neutral | {actor} turned {setting} {on_off}. |
| **Search verdicts (one per matched entry)** | | | |
| `verdict.sent` | SENT | neutral | Stored in {store} since {date} ({run}), and sent to {agent} of this run. |
| `verdict.left_out` | LEFT OUT | warn | Held, but left out of this run: {left_out_reason}. |
| `verdict.learned_after` | LEARNED LATER | neutral | Learned by {run} on {date}, after this run had read memory. |
| `verdict.other_store` | OTHER STORE | warn | Only in {store}, which this run did not read (it used {run_store}). |
| `verdict.never_stored` | NEVER STORED | warn | Offered by {run}, not stored: {reject_reason}. |
| `verdict.lost` | LOST | failed | Learned by {run}, but not stored: {unavailable_reason}. |
| `verdict.removed` | REMOVED | neutral | Removed on {date}: {removed_reason}. |
| `verdict.merged` | MERGED BY STORE | neutral | {store} merged it into another entry on {date}. |
| `verdict.forgotten_exact` | FORGOTTEN | neutral | An entry with exactly this text was forgotten by {actor} on {date}. |
| `verdict.in_memory` | IN MEMORY | success | In {store} since {date} ({run}). Runs on {subject} get it. |
| `verdict.none` | NO MATCH | neutral | Nothing held or recorded mentions "{q}". {learning_context} |

A note for stage 7: D3 has no code for deleting a whole notebook document.
The existing delete stays available on the notebook. It is recorded as
`removed.forgotten` with the kind `notebook`, and the sentence reads
"Notebook deleted by {actor}." Stage 7 either confirms this row or names
another code, and adds it to the module.

## Surfaces

### Shared building blocks

These are built once in stage 9a and used by every memory surface.

- **`Disclosure`**, promoted from `components/cockpit/screens/run-analysis-report.tsx:72`
  into `components/ui/`. It is an existing, tested pattern; the three other
  local copies stay where they are and are noted as follow-up debt.
  - It gains an optional `summary` slot, so the collapsed header can carry
    counts and chips.
  - It gains `aria-controls`.
  - `defaultOpen` is computed from "holds warn or failed".
- **`MemoryEntryRow`**. It shows one entry wherever entries appear.
  - Line 1: the chip, then the text in body 13. Backticked spans render as
    inline code; the rest is prose, not mono.
  - Line 2: a mono 11 meta line in neutral-600, for example
    `Blazity/aiw-checks-fixture · facts · score 0.82 · from AWP-270 · 2d ago`.
  - Links: the ticket key uses TicketLink, and the entry text links to the
    entry's anchor on `/memory`.
  - Line 3 appears only for an update: "Was" and "Now" pairs (see
    `MemoryEventRow`).
  - On a phone the chip moves above the text, and the meta line wraps as a
    whole line.
- **`MemoryEventRow`**, for the rail. The rail is the Health rail
  (`components/cockpit/screens/health.tsx:373-378`, a dot on a vertical line)
  inside an `<ol>`.
  - It carries a mono time, a chip, the sentence, the actor links, and the
    quoted text in the RoundView blockquote style
    (`components/cockpit/agent-visibility/round-view.tsx:37-50`).
  - An update shows two labelled blocks, "Was" and "Now". The old text is
    shown in full in neutral-700, not struck through, and the new text in
    coal. `DiffView` (`components/cockpit/prompt-diff.tsx:41`) is not used:
    it is line based, mono, and styled with raw hex, and a one-sentence fact
    has no lines to diff.
  - Erased text reads "Text erased when {actor} forgot it on {date}."
- **`SubjectName`**: the human subject name (principle 9) with `<wbr>` after
  the slash, plus a kind chip (FACTS, LESSONS, NOTEBOOK, ROUTING).
- **`StoreChip`**: `MEM0` or `BUILT-IN`, with a state suffix where it helps:
  `MEM0 · IN USE`, `BUILT-IN · NOT IN USE FOR FACTS`, `MEM0 · FAILING`,
  `MEM0 · KEPT FOR THIS RUN`, `MEM0 · NO LONGER IN USE`.
- **Time.** `<time dateTime>` carries the absolute moment from `formatMoment`
  (`lib/agent-visibility/format.ts:11`) in `title`.
  - Recency is shown relative, from `formatAgeMinutes`
    (`lib/date-time.ts:31`).
  - History rows show the absolute time in mono.
- **Sizes.** `formatBytes` from the vocabulary module. A limit keeps its name
  as the code spells it ("16 KiB budget", "256 KiB limit").

### 1. Run page: Memory card

**Purpose.** It says in five seconds what memory did for this run, and gets
to any entry in one click.

**Placement.**
- The card sits in `components/cockpit/screens/trace.tsx`, after AnswerPanel
  and before RunAnalysisReportCard, with the anchor `#memory`.
- The mono access line (`trace.tsx:505-509`) gains one segment, for example
  `memory: Mem0 · 4 sent · 1 learned · 1 not stored`, which links to
  `#memory`. Today nothing at the top of a run mentions memory.

**Wireframe (desktop).**

```
+-----------------------------------------------------------------------------+
| MEMORY                                              [MEM0 · KEPT FOR THIS RUN]|
| Mem0 served facts and lessons for this run, kept from its start.            |
|                                                                             |
| KNEW      7 entries for Blazity/aiw-checks-fixture (6 facts, 1 lesson)       |
| GIVEN     4 of 7 to 2 agents, ranked by ticket text    [3 LEFT OUT: BUDGET]  |
| LEARNED   1 learned, 1 changed                         [1 NOT STORED]        |
| NOTEBOOK  Saved, 3.1 KB                                        Open notebook |
|                                                                             |
| - WHAT IT WAS GIVEN   4 sent · 3 left out                                ^  |
|   QUERY  "Add retry with backoff to the webhook sender"                     |
|   Planning agent · 4 sent, 3 left out · 371 B of 16 KiB · Open briefing     |
|   [SENT]     pytest -m unit_tests runs and passes unit tests in             |
|              genai-engine/tests/                                           |
|              Blazity/aiw-checks-fixture · facts · score 0.82 · from AWP-270 |
|   [LEFT OUT] black and isort --profile black format Python code in ...      |
|              Left out of Planning agent: the 16 KiB memory budget was full. |
|   Implementation agent · the same 4 sent, the same 3 left out               |
| + WHAT IT LEARNED     1 learned · 1 changed · 1 not stored              v   |
|                                                                             |
| Search memory for this run ->                          Open in /memory ->   |
+-----------------------------------------------------------------------------+
```

The Given Disclosure is shown open because it holds a warn chip, and the
Learned one would be open for the same reason; it is drawn closed here only
to save space.

**Summary pattern.** The worker renders it as `summary` from the vocabulary
module. Each line has fixed variants.

| Line | Pattern | Variants |
|---|---|---|
| Headline | `{Store} served facts and lessons for this run, kept from its start.` | `..., read live: this run started before stores were kept per run.` (unpinned, E11) · `..., kept from its start. {Store} was turned off at {time}; the run went on without facts and lessons.` (E6, E10) |
| Knew | `{n} entries for {subjects} ({facts} facts, {lessons} lessons)` | `{Store} held nothing for {subjects} yet` · `unknown: {store} could not be read ({reason})` · `This run worked on no repository, so there was nothing to recall` |
| Given | `{sent} of {held} to {agents} agents, ranked by ticket text` | `..., not ranked: the ticket has no text` · `{sent} of {held}, the same set to every agent` · `Nothing to give` · `none: {reason}` (unavailable) |
| Learned | `{added} learned, {updated} changed, {removed} removed` (zero parts omitted) | `Nothing new: {known} already known` · `Skipped: {gate}` · `After the run is published` (live) · `Unavailable: {reason}; {lost} items not stored` |
| Notebook | `Saved, {bytes}` | `Cut at 256 KiB` · `None written` · `Not saved: the stored notebook was kept` · `No notebook: this run has no ticket` · `Not yet` (live) |

Chips on the beat lines show problems only: LEFT OUT with its main reason,
NOT STORED, REDACTED, UNAVAILABLE, SKIPPED, NOT RANKED. A beat with no
problem has no chip.

**Detail.**
- **Given.** One group per prompt build, in send order.
  - Group header: the agent label, "{sent} sent, {left} left out",
    "{used} of {budget}", "ranked by ticket text" or the not-ranked reason,
    and "Open briefing" (the replay deep link to that node's Briefing tab).
  - Inside a loop the header carries the iteration ("Implementation agent,
    pass 2").
  - A build identical to the one before collapses to one line, "the same 4
    sent, the same 3 left out".
  - The query is shown once, above the groups, as a labelled blockquote
    (micro label QUERY, body text). When builds used different queries, each
    group shows its own.
  - Row order inside a group is sent entries in prompt order, then left-out
    entries in rank order.
- **Learned.** It opens with the conservation line: "The run concluded 7
  things: 1 learned, 1 changed, 1 not stored, 3 already known, 1 removed."
  This makes "what did this run conclude" answerable (D3).
  - Rows are grouped by outcome, problems first: Not stored, Lost (store
    unavailable), Redacted, Learned, Changed ("Was" and "Now"), Removed,
    Refuted with no match.
  - "Already known" and "Confirmed" collapse into one counted line that
    expands.
  - The notebook row has its path, size and "Open notebook".
- **Links.** "Search memory for this run" opens `/memory/search?run=<id>`
  with focus in the search input. "Open in /memory" opens the documents list
  filtered to this run's subjects.

**States.**

| State | Card shows (exact copy) |
|---|---|
| Loading | CkCard with eyebrow MEMORY and a Skeleton for the headline and the four beat lines. |
| Load failed | LoadFailureNotice, what = "The memory report". Copy: "The memory report could not be loaded. The run itself is not affected." Retry button. |
| Memory off at start | One line: "Memory was off when this run started, so it recalled and learned nothing." Chip OFF (blocked). Link "Memory settings". No beats. |
| Before the ledger | Neutral Notice with the `predates_ledger` sentence and a link "Open the first agent's Briefing". Chip NOT RECORDED. |
| Live, nothing read yet | "Memory has not been read yet. The card fills in as agents start." Chip RUNNING (running tone, pulse allowed because it reports live work). |
| Live, recalled, not learned yet | Knew and Given filled in. Learned: "After the run is published". Notebook: "Not yet". |
| Waiting for a person | As the live state, plus a headline suffix: "Kept {store} while waiting." |
| Normal, complete | The four beats, with chips only for problems. |
| Nothing held (E1) | Knew: "Mem0 held nothing for Blazity/aiw-checks-fixture yet". Given: "Nothing to give". If the other store holds entries: "Built-in still holds 12 entries this run did not read." plus "Preview copy" (admins only). |
| No repository | Knew: "This run worked on no repository, so there was nothing to recall". |
| Not ranked (E21) | Given: "4 of 4 to 2 agents, not ranked: the ticket has no text". NOT RANKED chip (neutral). |
| Left out by budget (E22) | LEFT OUT chip on Given. The Given Disclosure opens by default with the left-out rows focused. |
| Partly ranked (E24) | Rows without a score carry NOT RANKED with the `not_ranked.no_score` sentence. |
| Merged by the store (E36) | Left-out rows with `left_out.superseded`. |
| Learning skipped (E28) | Learned: "Skipped: memory learns only from successful runs, and this one failed." SKIPPED chip (blocked). The Disclosure stays closed. |
| Learning ran, nothing new | Learned: "Nothing new: 3 already known". No chip. |
| Rejections or redactions | NOT STORED or REDACTED chip. The Learned Disclosure opens by default. |
| Recall unavailable (E3, E4) | A failure Notice above the beats: "Mem0 rejected the key at 11:02 (401). The agents got no facts or lessons; the notebook was not affected." Action: "Open Mem0" (integration page). Knew: "unknown: Mem0 could not be read (key rejected)". |
| Learning unavailable (E5) | A failure Notice: "Mem0 quota was spent at 11:40 (413). 2 learned items were not stored:" followed by the two items as rows with chip LOST. Knew and Given are normal. |
| Store changed mid-run (E6, E7, E10, E27) | StoreChip `MEM0 · NO LONGER IN USE`. Headline suffix per the pattern. A lost-tone Notice with the `unavailable.store_disabled` or `unavailable.store_changed` sentence. |
| Two stores on (E8) | A failure Notice with the `unavailable.ambiguous` sentence and "Turn one off on Integrations." (link). Knew and Given read "none: two stores were on". |
| Record incomplete (E26) | A lost-tone Notice with the `record_incomplete` sentence, listing the entries found in the store but not in the record. RECORD INCOMPLETE chip in the card action. |
| Not yet searchable (E34) | The row chip is LEARNED, and its sentence is `added.pending`. |
| Notebook withheld | Notebook line: "Not saved: the stored notebook was kept". KEPT OLD chip (warn). The sentence appears in the Learned detail. |
| Notebook cut (E12) | Notebook line: "Cut at 256 KiB". CUT chip (warn). |
| Unknown code from a newer worker | The row shows the worker's sentence with the code as a neutral chip. |

**Interactions.**
- A count on a beat line ("4 of 7", "3 left out", "1 not stored") is a text
  Button. It opens the matching Disclosure and moves focus to the first
  matching row.
- Chips are labels, not controls.
- Each Disclosure keeps its open state in the URL hash (`#memory-given`), so
  a pasted link opens the same view.
- While the run is live, the card refreshes with the run page's existing
  live poll. Nothing polls when the run is finished.

**Phone (390 px).**
- Beat labels sit above their sentences, and chips wrap onto their own line
  under the sentence.
- Disclosure headers span the full row and are at least 44 px tall.
- Entry meta lines wrap as whole lines.
- The access-line segment stays one tap to the card.

**Data contract** (`GET /api/v1/runs/:id/memory`, MCP `runs.memory`; stage 7):

```ts
interface RunMemoryReport {
  runId: string; ticketKey: string | null;
  record: "complete" | "incomplete" | "predates_ledger";
  recordStartsAt: string;                       // deployment ledger start
  memoryEnabled: boolean | null;                // frozen settings; null = unknown
  store: {
    id: string; label: string;                  // "mem0" | "builtin" | future ids
    pinned: boolean;                            // false = read live (E11)
    servingNow: boolean | null;
    project: { orgId: string; projectId: string; name: string | null } | null;
    changedAt: string | null; changeCode: string | null;
  } | null;
  summary: { headline: string; knew: string; given: string; learned: string; notebook: string };
  knew: { entries: number | null; facts: number | null; lessons: number | null;
          subjects: SubjectLabel[]; unknownReason: string | null };
  query: string | null;                         // redacted, as sent to the store
  recalls: Array<{
    nodeId: string; nodeLabel: string; iteration: number | null;
    attemptId: string; briefingId: string | null; at: string;
    query: string | null; ranked: boolean; notRankedCode: string | null;
    budgetBytes: number; usedBytes: number; sameAsPrevious: boolean;
    entries: RecallEntry[];
  }>;
  learning: {
    state: "ran" | "skipped" | "not_yet" | "unavailable" | "unknown";
    skip: { code: string; sentence: string } | null;
    concluded: string | null;                   // the conservation sentence
    events: MemoryEvent[];
  };
  notebook: { state: "saved" | "truncated" | "absent" | "withheld" | "no_ticket" | "not_yet" | "unknown";
              path: string | null; bytes: number | null; sentence: string; href: string | null };
  unavailable: Array<{ phase: "recall" | "learning"; code: string; sentence: string;
                       at: string; status: number | null; lost: MemoryEvent[] }>;
  missing: MemoryEvent[];                       // record incomplete
  accessLine: string;                           // "memory: Mem0 · 4 sent · 1 learned · 1 not stored"
}
interface SubjectLabel { key: string; display: string; kind: "repository" | "org" | "ticket" }
interface RecallEntry {
  entryId: string; subject: SubjectLabel; kind: "facts" | "lessons"; text: string;
  origin: "learned" | "derived" | "imported";
  state: "sent" | "left_out"; code: string; sentence: string;
  score: number | null; bytes: number;
  taughtBy: { runId: string; ticketKey: string | null; at: string } | null;
  href: string;                                 // /memory entry anchor
}
interface MemoryEvent {
  id: string; at: string; code: string; sentence: string;
  actor: { type: "run" | "admin" | "mcp" | "environment"; label: string;
           runId: string | null; ticketKey: string | null };
  store: string; subject: SubjectLabel; kind: string;
  entryId: string | null; text: string | null; textErasedAt: string | null;
  previousText: string | null; bytes: number | null; href: string | null;
}
```

### 2. Run page: replay and Briefing memory sections

**Purpose.** Make the fourth send reachable and connect the Briefing to the
card. Today the run says "4 sends, all recorded" and only 3 can be opened.

**Wireframe.**

```
EXECUTED WORKFLOW
[trigger] [prepare] [planning] ... [implementation] [publish] [status]
RUN-LEVEL SENDS
[Memory learning]
```

**Detail.**
- A "Run-level sends" strip sits under the block row in `WorkflowReplay`. It
  holds one pill per send that has no graph node; today that is the
  `run:repo-memory-distill` send (`apps/worker/src/engine/agent-workflow.ts:5188`),
  labelled "Memory learning".
- The strip is shown only when such a send exists.
- The deep link `?node=run:repo-memory-distill` resolves to this pill and is
  never rewritten to `status`. The pill list must include run-level attempts
  that `graphAttempts` filters out today.
- Tabs for this pill:
  - Briefing: the SendView as for any send.
  - Output: the Learned detail of the Memory card (same component, same
    rows), headed "What the run concluded".
  - Input, Logs, Metadata and Attempts show what the replay holds for that
    attempt, and each says so in one sentence when it holds nothing.
- **Briefing memory sections** ("Repository memory" and "Memory",
  `lib/agent-visibility/wording.ts:276,280`):
  - The collapsed header carries a meta line, "4 of 7 entries sent, 3 left
    out (budget)", so the counts read without opening.
  - The expanded body starts with two links: "See the Memory card" (`#memory`)
    and "Open document" (`/memory` detail).
- **Phone.** Section badges move under the section title at 390 px, so a
  title never wraps one letter per line. This is a SendView header fix, so
  every section gets it. Production today shows "Runtime data" one character
  per line.

**States.**
- No run-level send: no strip.
- A distill send that has an input but no recorded output (a run from before
  the ledger): the Output tab says "The decision of this send was not
  recorded; runs from {date} on record it."
- Learning skipped: there is no send, so no pill. The card's SKIPPED line is
  the explanation.

**Data contract.**
- The replay response lists run-level attempts with
  `{ nodeId, label, attemptId, briefingIds }`.
- The Output tab reuses `RunMemoryReport.learning`.
- The Briefing section index gains `memory: { sent, heldTotal, leftOut,
  mainReason } | null` per memory section, computed from the `recalled` row
  of that build.

### 3. `/memory`: header, search bar, store panel

**Purpose.** Say where memory lives and whether it is healthy, and put the
search one tab-press away from arriving. Today the first screen is settings.

**Wireframe (desktop).**

```
AGENT MEMORY
Memory                                    [ Search memory: words, ticket, run id ] [Search]
Facts and lessons: Mem0 · Notebooks and routing: built-in · Repository memory on

WHERE MEMORY IS KEPT
Mem0 serves facts and lessons and answered 2m ago. Built-in keeps notebooks
and routing, and still holds 12 facts and lessons that runs no longer read.
+-----------------+-----------+----------------------+------------------------------------+
| Facts, lessons  | Mem0      | [IN USE]             | Stored key · since 16 Sep          |
|                 |           |                      | 3 runs pinned: 1 running, 2 waiting|
|                 |           |                      | Last error 21 Sep 10:42:           |
|                 |           |                      | quota spent (413)       Open Mem0 ->|
| Notebooks,      | Built-in  | [ALWAYS]             | 4 notebooks · routing off          |
| routing         |           |                      |                                    |
| Older facts     | Built-in  | [NOT IN USE]         | 12 entries, newest 15 Sep          |
| and lessons     |           |                      | [Preview copy to Mem0]             |
+-----------------+-----------+----------------------+------------------------------------+

[Documents 4] [Search] [Timeline] [Settings]
```

**Summary pattern.** The worker renders the panel sentence:
`{Active} serves facts and lessons and answered {age}. Built-in keeps
notebooks and routing{, and still holds {n} facts and lessons that runs no
longer read}.` When built-in is the active store:
`Built-in serves facts, lessons, notebooks and routing.` When Mem0 is
connected but not in use, one more clause: `Mem0 holds {n} entries runs no
longer read.`

**Detail.**
- The header status line reads the three memory switches: "Repository memory
  on/off", "Org promotion on/off", and "Routing memory on/off", this last
  only when on. Each part links to the Settings tab.
- The panel is a `<table>` with one row per role, not one per store. This
  says D8 (built-in never inactive) in its layout.
- The source column says "Stored key" or "From environment
  (AIW_MEM0_API_KEY)" (E2).
- "Last error" gives the reason in body text; only the HTTP status is mono.
  It reads "No errors in the last 7 days" when there were none, and "unknown"
  when the status could not be read.
- The generic settings note ("Values saved here are stored and read by the
  worker per request...") moves to the Settings tab.

**States.**

| State | Panel |
|---|---|
| Loading | Skeleton rows. The documents tab loads independently. |
| Status unreadable | A LoadFailureNotice for "The memory store status". The documents list still renders. |
| Built-in only | One row: "Facts, lessons, notebooks, routing · Built-in · [IN USE]". No copy offer. |
| First connect (E1) | "Mem0 is empty. Runs start without facts and lessons until they learn, or until you copy the 12 built-in entries." plus [Preview copy to Mem0]. |
| Failing (E3, E4) | Chip `MEM0 · FAILING` (failed). A failure Notice: "Mem0 has failed since 11:02: key rejected (401). Runs go on without facts and lessons." Action "Open Mem0". |
| Two stores (E8) | A failure Notice: "Two memory stores are on. Runs get no facts or lessons until one is off." Action "Open Integrations". Both rows show [ON]. |
| Disconnected (E7) | Row "Older facts and lessons · Mem0 · [DISCONNECTED]: its entries stay in your Mem0 account, unreachable from here until a key for the same project is saved." |
| Back on built-in (E9) | Built-in [IN USE] with the entry ages. Mem0 [NOT IN USE] with its count and [Preview copy to built-in]. |
| Pinned count unknown | "Could not count runs using Mem0: {reason}." Never "0 runs". |
| Legacy notebooks in Mem0 (D9) | A row "Notebooks from before 23 Sep · Mem0 · [MOVED 3 of 4]", which links to the filtered list. |

**Interactions.**
- The search input submits on Enter or with the button, to
  `/memory/search?q=`. No new keyboard shortcut: the dashboard's only
  global one is the spotlight's Cmd+K.
- Tabs are RouteTabs: `/memory` (Documents), `/memory/search`,
  `/memory/timeline`, `/memory/settings`.

**Phone.**
- Title, then the search input at full width, then the panel sentence with
  its chips.
- The role table collapses into a Disclosure "Stores (3)", closed unless a
  row is failing or two stores are on.
- Then the tabs. Documents start within the first screen.

**Data contract** (`GET /api/v1/memory/stores`, and MCP `memory.list`
`stores`):

```ts
interface MemoryStores {
  summary: string;
  switches: { repositoryMemory: boolean | null; orgPromotion: boolean | null; routingMemory: boolean | null };
  ambiguous: boolean;
  roles: Array<{
    role: "facts_lessons" | "notebooks_routing" | "inactive_facts_lessons" | "legacy_notebooks";
    store: { id: string; label: string };
    status: "in_use" | "always" | "not_in_use" | "failing" | "disconnected" | "unknown";
    source: "stored" | "environment" | "builtin";
    since: string | null;
    lastSuccessAt: string | null;
    lastError: { at: string; code: string; status: number | null; sentence: string } | null;
    held: { facts: number | null; lessons: number | null; notebooks: number | null; newestAt: string | null };
    pinnedRuns: { running: number; awaiting: number } | null; pinnedRunsError: string | null;
    project: { orgId: string; projectId: string; name: string | null } | null;
    transferOffer: { to: string; count: number | null } | null;
    href: string | null;                        // integration page
  }>;
  recordStartsAt: string;
}
```

### 4. `/memory`: Documents

**Purpose.** Find the document for a repository, a ticket or a run, and see
at once how big and how fresh it is and who wrote it last.

**Wireframe (desktop).**

```
[All 4] [Facts 2] [Lessons 1] [Notebooks 1]     Store [In use v]  Repository [All v]
SUBJECT                          KIND       ENTRIES   SIZE     UPDATED   LAST RUN
Blazity/aiw-checks-fixture       [FACTS]          5   559 B    2h ago    AWP-272
Blazity/aiw-checks-fixture       [LESSONS]        1    98 B    2h ago    AWP-272
Blazity/ai-workflow-demo         [FACTS]          4   129 B    2h ago    seeded
AWP-274                          [NOTEBOOK]       .   1.5 KB   2h ago    AWP-274
                                                           < 1 2 >
```

**Detail.**
- Kind tabs with counts come first (CkTabs). Then a Select for the store:
  "In use" (the default: the active store's facts and lessons plus built-in
  notebooks), "Built-in", "Mem0", "All stores".
- A second Select narrows by repository. A `?run=` filter (set from the run
  card) shows a removable chip "for run AWP-272".
- Columns:
  - Entries is right-aligned, with "." for a notebook.
  - Size uses `formatBytes`.
  - Updated is relative, with the absolute time in `title`.
  - Last run is a TicketLink plus `runHref`. "seeded" is used for derived
    entries.
  - A Store column appears only under "All stores".
- The "NO TICKET" label of today's rows is dropped: a repository document
  never has a ticket.
- A row click opens the detail (section 5), and the list keeps its filters in
  the URL.

**States.**
- Loading: Skeleton rows.
- Empty deployment: "Nothing learned yet. Memory learns after a successful,
  published run."
- Empty filter: "No lessons in Mem0 for Blazity/aiw-checks-fixture." (the
  sentence names the filter).
- Store unavailable: the rows of the other store still show, with a failure
  Notice above: "Mem0 could not be listed: key rejected (401). Showing
  built-in only."
- Memory off: an info Notice, "Repository memory is off: runs neither read
  nor learn. What is stored stays here." plus a link to Settings.
- Inactive store selected: a neutral Notice, "Runs have not read these since
  23 Sep. You can read, forget or copy them."
- Legacy Mem0 notebook: chip LEGACY with "moved" or "not yet moved".

**Phone.** No column is hidden.
- Each row becomes two lines. Line 1: SubjectName and the kind chip.
- Line 2, in mono: `5 entries · 559 B · 2h ago · AWP-272`.
- The filters stack: tabs scroll horizontally inside their own container
  (the page does not), and the Selects sit at full width.

**Data contract** (`GET /api/v1/memory?kind=&store=&subject=&run=&cursor=`):
`{ items: Array<{ subject: SubjectLabel; kind; store: { id, label, inUse:
boolean }; docPath; entryCount: number | null; bytes: number | null;
updatedAt: string | null; lastRun: { runId, ticketKey } | null;
derivedOnly: boolean; legacy: "moved" | "not_moved" | null; href }>; counts:
{ facts, lessons, notebooks, routing }; total; nextCursor }`.

### 5. `/memory`: Document detail (entries, notebook, history)

**Purpose.** See each entry with who taught it, see how the document got
here, and remove the one wrong entry.

**Wireframe (desktop).**

```
<- Documents (filters kept)
REPOSITORY MEMORY · MEM0 · IN USE
Blazity/aiw-checks-fixture  [FACTS]
5 entries · 559 B · updated 2h ago by AWP-272

[Entries 5] [History 14]

[LEARNED] pytest -m unit_tests runs and passes unit tests in genai-engine/tests/
          from AWP-270 · 21 Sep · sent to 3 runs                History   Forget
[LEARNED] is_past_recency_horizon() in genai-engine/src/fixture_engine/scoring.py
          returns True when document age in days is >= RECENCY_HORIZON_DAYS ...
          from AWP-272 · 23 Sep · changed once                   History   Forget
[DERIVED] Default branch is main.
          seeded · 16 Sep                                                  Forget
```

**Detail.**
- The detail has its own URL: `/memory/doc?subject=&kind=` for facts and
  lessons, `&path=` for notebooks. An entry anchor is `#entry-<id>`, and it
  selects the row with the mariner-100 token (never raw hex, never the
  `primary` variant).
- The detail replaces the list at every width, and "Documents" goes back
  with the filters kept.
- An entry row is a `MemoryEntryRow`. Its origin chip is LEARNED, DERIVED or
  IMPORTED, plus REDACTED or NOT YET SEARCHABLE when true. Its meta line
  reads "from {ticket} · {date} · sent to {n} runs · changed {n} times".
- History on a row jumps to the History tab filtered to that entry.
- Forget is an IconButton with the text label "Forget" on desktop and an
  accessible name on phone.
- **Notebook.** The tabs are Notebook and History.
  - The notebook renders as markdown with the read-only preview recipe
    (DESIGN.md "Prompt content exception").
  - Text between `<!-- human-decisions:start -->` and its end marker renders
    as a labelled block, "Human decisions (3)", in a neutral Notice.
  - An MCP client id is shown by the client's name, or as "an MCP client (id
    gzXPDY...)" when the name is unknown.
  - "Show raw" (a text Button) switches to the exact text in a light `<pre>`
    with a CopyButton.
  - Delete notebook keeps today's arm-then-confirm pattern and names what is
    lost: "Delete the AWP-274 notebook? It holds 3 human decisions. The next
    run of AWP-274 starts without it."
- **History.** It uses the rail (`MemoryEventRow`), newest first, with "Load
  older" (pages held by the parent, as in the repository History tab,
  `app/(cockpit)/repositories/repository-entry.tsx:1056-1192`).
  - Consecutive rows from one run group under a run header line, for example
    "AWP-272 · wrun_...ZNZ8C · 23 Sep 14:23".
  - Filter chips (CkTabs): Changes (the default: learned, changed, removed,
    forgotten, copied), Problems (not stored, redacted, lost), and Sent (the
    `recalled` rows, which would swamp the rail by default). The Sent tab
    shows "Sent to 12 runs" with each run as a row.
  - The rail ends with "History starts 23 Sep. Earlier changes were not
    recorded." when the document is older than the ledger.

**States.**
- Loading: Skeleton.
- Not found: "This document is not in {store} any more. It may have been
  forgotten or deleted; see the Timeline." plus a link.
- Inactive store: a neutral Notice, "Runs have not read these since 23 Sep.
  You can read, forget or copy them."
- Store unavailable: a failure Notice with the reason. The History tab still
  works (it reads the ledger).
- Redacted on read (E15): the text shows `[redacted]`, and a note reads "A
  value in this entry became a known secret after it was stored. Forget
  removes it from the store."
- Pending (E34): NOT YET SEARCHABLE chip.
- Legacy notebook: "This notebook is in Mem0 from before 23 Sep. It was
  moved to built-in on {date}." or "... and has not been moved yet."

**Phone.** The header wraps after the slash. The tabs stay. Entry actions
move under the meta line as text buttons. The rail keeps its dots with a
16 px gutter.

**Data contract.**
- `GET /api/v1/memory/doc?subject=&kind=|path=` returns: `{ subject:
  SubjectLabel; kind; store: { id, label, inUse }; bytes; entryCount;
  updatedAt; lastRun; entries: Array<{ entryId; text; origin; redacted:
  boolean; pending: boolean; bytes; taughtBy: { runId, ticketKey, at } |
  null; changedCount: number; sentToRuns: number | null; href }>; notebook:
  { markdown: string; humanDecisions: Array<{ at, actor, text }>; clients:
  Record<string, string> } | null; legacy: ... | null }`.
- `GET /api/v1/memory/history?subject=&kind=&entryId=&filter=&cursor=`
  returns `{ events: MemoryEvent[]; nextCursor; recordStartsAt; counts: {
  changes, problems, sent } }`.

### 6. `/memory`: Forget one entry

**Purpose.** Remove one wrong or sensitive entry and know exactly what is
gone and what is not.

**Wireframe (Modal).**

```
Forget this fact?

"mypy type checks genai-engine/ cleanly with no errors"
Blazity/aiw-checks-fixture · facts

It leaves Mem0 now, and no later run is sent it. This history keeps who
forgot it and when, not the text.

Also removed: 1 copy in built-in (not in use).

Not reached:
- The Briefings of 3 runs that were sent it (AWP-270, AWP-271, AWP-272),
  kept as the record of what each model saw.
- Mem0's own history of this memory and its project event feed.

1 run is learning on Blazity/aiw-checks-fixture now (AWP-280) and may
learn it again.
                                              [Cancel]  [Forget fact]
```

**Detail.**
- The worker computes the preview (forget by normalised-text hash, D2), and
  the Modal renders every list it returns.
- `delete_linked` memories are named when Mem0 reports any: "Mem0 will also
  delete 2 older memories this one replaced."
- [Forget fact] is the danger Button. Initial focus is on Cancel.
- After it succeeds, the row is replaced in place by a neutral Notice:
  "Forgotten. A run may learn it again." Focus moves to that Notice, and the
  History tab gains the row.

**States.**
- Preview loading: the body shows a Skeleton, and [Forget fact] is disabled
  until the preview arrives.
- Preview failed: "What forget would reach could not be worked out: {reason}.
  Nothing was forgotten." Only Close.
- Store unavailable: "Mem0 cannot be reached ({reason}), so the entry cannot
  be forgotten there now. Nothing was forgotten."
- Partly done (one store failed): a failure Notice: "Forgotten in built-in;
  Mem0 refused ({status}). The entry is still in Mem0." with Retry.
- Briefing runs over 5: the first 5 by key, then "and 9 more", which links to
  the entry's Sent history.

**Phone.** The Modal is full width. The quote wraps. The buttons stack with
the danger button last.

**Data contract.**
- `POST /api/v1/memory/forget/preview { subject, kind, entryId }` returns:
  `{ text; matches: Array<{ store, subject, kind, entryId, inUse }>;
  briefingRuns: Array<{ runId, ticketKey }>; briefingRunsTotal: number |
  null; storeHistory: "kept" | "cleared" | "unknown"; linkedMemories: number
  | null; runsLearningNow: Array<{ runId, ticketKey }>; ledgerRowsToBlank:
  number; sentences: string[] }`.
- `POST /api/v1/memory/forget { subject, kind, entryId, idempotencyKey }`
  returns `{ outcomes: Array<{ store, state: "forgotten" | "not_found" |
  "refused", sentence }> }`.

### 7. `/memory`: Search

**Purpose.** Answer "why didn't the agent remember X" in one verdict
sentence, with or without a run in mind.

**Wireframe (desktop).**

```
[ retry ______________________________ ] [Search]   [for run AWP-272  x]  Repository [All v]
3 matches. Searched: Mem0 (facts, lessons), built-in (all kinds), the record since 23 Sep.

[LEFT OUT] Held, but left out of this run: the 16 KiB memory budget was full.
           "Webhook sends are retried 3 times with exponential backoff"
           Blazity/aiw-checks-fixture · facts · Mem0 · from AWP-270
           + Trail (4)                                          Open entry ->
[OTHER STORE] Only in built-in, which this run did not read (it used Mem0).
           "Retry budget lives in WEBHOOK_RETRY_MAX"
           + Trail (1)                          Preview copy   Open entry ->
[NEVER STORED] Offered by AWP-265, not stored: it contains a URL.
           "See https://... for the retry policy"
           + Trail (1)
```

**Detail.**
- Search matches words, not meaning (no Mem0 search call, no quota). It runs
  over:
  - current entries in both stores;
  - ledger texts (texts, previous texts and detail items);
  - the normalised-text hash of the whole query against forgotten hashes, so
    an exact forgotten text still gives `verdict.forgotten_exact`.
- Results are grouped per entry, following id chains through updates. Each
  group shows one verdict chip and sentence, the current text (or the last
  text for removed or rejected), the SubjectName, the store, and a collapsed
  Trail (the rail rows for that entry).
- With `run=` the verdicts are about that run: `sent`, `left_out`,
  `learned_after`, `other_store`. Without a run they are about now:
  `in_memory`, `removed`, `never_stored`, `lost`, `merged`,
  `forgotten_exact`.
- Order: verdicts that answer "why not" (left out, other store, never
  stored, lost, removed) come before "it is there".
- The scope line always says what was searched and since when.

**States.**
- Before a search: "Search what memory holds and what runs recorded. It
  matches words, not meaning. Paste a phrase the agent should have known."
  plus the last 5 searches kept per viewer (browser storage, wrapped in
  try/catch).
- Searching: Skeleton groups. A second submit cancels the first.
- No match: the `verdict.none` sentence with context, for example: "Nothing
  held or recorded mentions "retry". Learning ran 3 times on
  Blazity/aiw-checks-fixture since 23 Sep; the last run, AWP-280, skipped it:
  run failed. 2 entries were forgotten since; their text is not kept, so
  only an exact phrase can match them."
- A store unavailable: a failure Notice above the results, "Mem0 could not
  be searched: key rejected (401). Results come from built-in and the record
  only."
- A run before the ledger: "AWP-251 started before memory was recorded, so
  verdicts about it are not possible. Showing what memory holds now."
- Too short a query (under 3 characters): an inline hint, "Type at least 3
  characters." No request is sent.
- Too many matches (over 50 groups): "Showing the first 50 matches; narrow
  by repository." plus CkPagination.

**Interactions.** The query, run and repository live in the URL, so a result
can be pasted into Slack. "Open entry" goes to the detail anchor. "Preview
copy" opens section 9 prefilled with that entry.

**Phone.** The input is full width. The run chip and repository Select wrap
under it. A verdict chip sits above its sentence. Trail rows use the rail.

**Data contract** (`GET /api/v1/memory/search?q=&run=&subject=&cursor=`, MCP
`memory.search`):
`{ query; run: { runId, ticketKey, store } | null; searched: { stores:
Array<{ id, kinds, ok: boolean, sentence: string | null }>; ledgerSince:
string }; groups: Array<{ verdict: { code, sentence }; entry: { entryId:
string | null; subject: SubjectLabel; kind; store: string | null; text: string
| null; href: string | null }; trail: MemoryEvent[]; actions: Array<"open" |
"copy" | "forget"> }>; none: { sentence } | null; total; nextCursor }`.

### 8. `/memory`: Timeline

**Purpose.** Show every change to where memory lives and to what it holds
that a person made: switches, copies, forgets, sweeps, and memory settings.

**Wireframe.**

```
[All] [Switches] [Copies] [Forgets] [Settings]
o 23 Sep 15:02  [SWITCHED]  Filip switched facts and lessons from built-in to Mem0.
                            2 runs in flight kept built-in (AWP-280, AWP-281).
o 23 Sep 15:05  [COPIED]    Filip copied 9 entries from built-in to Mem0.   Details
o 23 Sep 16:10  [FORGOTTEN] Filip forgot 1 fact in Blazity/aiw-checks-fixture.
o 22 Sep 09:00  [SETTING]   Filip turned repository memory on.
History starts 23 Sep for switches, copies and forgets.
```

**States.**
- Empty: "No switches, copies or forgets yet. Memory has been served by
  {store} since the record started on 23 Sep."
- A switch from the environment: the `store_changed.environment` sentence.
- Unreadable settings history: a Notice "Setting changes could not be read;
  showing memory events only."

**Phone.** The rail stays. Time sits above the chip.

**Data contract.** `GET /api/v1/memory/history?scope=deployment&filter=&cursor=`
returns ledger rows with codes `store_changed.*`, `imported.*` and
`removed.forgotten`, merged by the worker with settings-history rows for the
three memory switches (`setting_changed`), plus `runsKeptOldStore:
Array<{ runId, ticketKey }> | null` on switch rows.

### 9. `/memory`: Copy between stores

**Purpose.** Move facts and lessons across on purpose, knowing beforehand
exactly what will land (Q1).

**Wireframe (Modal).**

```
Copy facts and lessons from built-in to Mem0

Will copy               9 entries, 3.2 KB                       + show
Already in Mem0         3, skipped                              + show
Over the 40-fact limit  1, the oldest learned, not copied       + show
Refuted on Mem0         2 since 23 Sep   [x] leave these out    + show
Written after switch    1 by AWP-290 (pinned to built-in)        + show
Notebooks and routing are never copied; they always stay in built-in.
The record starts on 23 Sep; refutations before that date are not known.

                                          [Cancel]  [Copy 9 entries]
```

**Detail.**
- The worker computes the preview through the apply plan and returns a
  `planHash`.
- Apply sends the hash. When the stores changed in between, the worker
  refuses and returns a fresh preview, and the Modal replaces its body with:
  "Mem0 changed since the preview. This is what would copy now." The button
  count updates.
- Each line expands into `MemoryEntryRow`s.
- The "leave these out" Checkbox (the primitive) removes the refuted entries
  from the copy, and the button count updates.
- After it succeeds: "Copied 9 entries to Mem0. They are on the Timeline."
  with a link. The store panel refreshes.

**States.**
- Nothing to copy (E20): "Nothing to copy: all 12 are already in Mem0." with
  only Close.
- Target unavailable: "Mem0 cannot be reached ({reason}). Nothing was
  copied."
- Partly copied: a failure Notice: "7 of 9 copied; Mem0 refused 2 ({status}).
  They are listed below; run the copy again to retry them."
- Not an admin: the offer is not rendered. A direct call gets the route's
  refusal, shown as a Notice.

**Phone.** A full-width Modal. The lines become two-row blocks (label, then
count). The Checkbox gets its own row.

**Data contract.**
- `POST /api/v1/memory/transfer/preview { from, to }` returns `{ planHash;
  from; to; sections: Array<{ code: "will_copy" | "already_there" |
  "over_cap" | "refuted_elsewhere" | "written_after_switch"; count: number;
  bytes: number | null; sentence: string; entries: RecallEntry[] }>;
  neverCopiedSentence; recordStartsAt }`.
- `POST /api/v1/memory/transfer { planHash, dropRefuted }` returns `{
  outcomes } | 409 { preview }`.
- MCP `memory.transfer_preview` is read only (Q1).

### 10. `/memory`: Settings tab

This is where the "Memory switches" SettingsGroupForm moves, unchanged, with
the generic settings note. The switch copy that promises the notebook "is
always hydrated and persisted" is corrected to "Notebooks always live in
built-in and are saved after each ticket run, unless the run could not read
the stored one."

### 11. Integrations: Mem0 page and disable preview

**Purpose.** Show the store's health, and before a switch, what it does to
runs in flight.

**Wireframe (on `/integrations/mem0/connection`, above the key field).**

```
MEMORY ON THIS DEPLOYMENT
Mem0 serves facts and lessons. Built-in keeps notebooks and routing.
Answered 5m ago. Last error 21 Sep 10:42: quota spent (413).
12 runs use Mem0: 3 running, 9 waiting for a person.
Project aiw (org Blazity).                                   Open memory ->
```

**Disable preview.** The existing preview behind the availability switch
(`connection-screen.tsx:878`) renders this text from `presentation.ts:784`
and `:946-971`:

> 12 runs use Mem0: 3 running, 9 waiting for a person. They keep Mem0: from
> their next memory step they go on without facts and lessons, and they are
> not stopped and do not switch stores. New runs use built-in (12 facts and
> lessons from before 23 Sep). Nothing in Mem0 is deleted.

**Disconnect confirmation.** It uses the same sentences, plus: "Entries stay
in your Mem0 account, unreachable from here until a key for the same project
is saved." Today's line "runs that need it fail until it is connected again"
is removed for memory; it contradicts D4.

**Key for another project (E27).** After Test, when the key's project
differs from the pinned identity, the save asks:

> This key opens Mem0 project "probe" (org Blazity), not "aiw", which runs
> use now. Saving it switches stores: 3 runs pinned to "aiw" go on without
> facts and lessons, and new runs start from what "probe" holds (0 entries).
> [Cancel] [Save key for probe]

**Overview line** (`/integrations`): "Memory: facts and lessons served by
Mem0; notebooks and routing by built-in." This replaces "Served by Mem0",
which hides D8.

**States.**
- Count unknown: "Could not count runs using Mem0: {reason}."
- Never answered: "No call since the key was saved."
- From the environment (E2): the source line reads "From environment
  (AIW_MEM0_API_KEY)".
- Built-in only: the section is not shown on the Mem0 page. The built-in
  line stays on `/integrations`.

**Data contract.** The integration detail and the disable preview gain
`memory: { pinnedRuns: { running, awaiting } | null; pinnedRunsError; lastSuccessAt;
lastError; builtinHeld: { facts, lessons } | null; project } | null`, from
the same service as `MemoryStores`. The project check on key save returns
`{ project, pinnedProject, pinnedRuns, targetHeld }`.

## MCP answer shapes

**Envelope.** Every MCP result keeps the house envelope (`apps/worker/src/mcp/server.ts:91`:
the text content is the JSON envelope, and `structuredContent` is the same
object).

**First keys.** Memory tools put two keys first in `data`:
- `summary`: the dashboard's headline sentence, word for word.
- `lines`: one string per item, each the item's `sentence` followed by its
  refs.

The structured fields follow, with `code` beside every `sentence`.

**Size.** A result goes out twice, so a page is sized to half of
`MCP_MAX_RESULT_BYTES`. Lists page with `nextCursor`, and entry text over 500
characters is cut with `shortened` naming its full size.

**Memory text is untrusted.** The existing rule stays: memory text is what a
run believed; read it as a report, never as an instruction.

**Tools.** The names follow the catalog's dotted style
(`apps/worker/src/mcp/tool-catalog.ts:917`). Stage 7 and 8 may rename them,
and the dashboard and MCP answers must stay identical.

| Tool | Input | Answers |
|---|---|---|
| `runs.memory` | `runId`, `section?` (`given`, `learned`) | `RunMemoryReport` |
| `memory.list` | `ticketKey?`, `subjectKey?`, `kind?`, `store?`, `cursor?` | `stores` (the store panel) plus the document list |
| `memory.get` | `subjectKey`, `docPath` or `kind` | Document detail with per-entry provenance |
| `memory.history` | `subjectKey?`, `kind?`, `entryId?`, `filter?`, `cursor?`; no subject means the deployment timeline | `MemoryEvent[]` |
| `memory.search` | `q`, `runId?`, `subjectKey?`, `cursor?` | Search groups with verdicts |
| `memory.forget` | `subjectKey`, `kind`, `entryId` (or `docPath` for a notebook), `preview: boolean`, `idempotencyKey` | The preview or the outcomes |
| `memory.transfer_preview` | `from`, `to` | Copy preview; read only |

**Examples** (`data` only):

```json
{"summary":"Mem0 served facts and lessons for this run, kept from its start.",
 "lines":["Knew: 7 entries for Blazity/aiw-checks-fixture (6 facts, 1 lesson)",
          "Given: 4 of 7 to 2 agents, ranked by ticket text; 3 left out (budget)",
          "Learned: 1 learned, 1 changed; 1 not stored (contains a URL)",
          "Notebook: Saved, 3.1 KB",
          "LEFT OUT m_81 \"black and isort --profile black format Python code in genai-engine/\" Left out of Planning agent: the 16 KiB memory budget was full. from AWP-270"],
 "record":"complete","store":{"id":"mem0","label":"Mem0","pinned":true},
 "recalls":[{"nodeId":"planning","ranked":true,"budgetBytes":16384,"usedBytes":371,
   "entries":[{"entryId":"m_81","state":"left_out","code":"left_out.budget",
     "sentence":"Left out of Planning agent: the 16 KiB memory budget was full.",
     "score":0.41,"taughtBy":{"runId":"wrun_01M370G5...","ticketKey":"AWP-270"}}]}],
 "learning":{"state":"ran","concluded":"The run concluded 7 things: ...","events":[...]}}
```

```json
{"summary":"Mem0 serves facts and lessons and answered 2m ago. Built-in keeps notebooks and routing, and still holds 12 facts and lessons that runs no longer read.",
 "lines":["Blazity/aiw-checks-fixture facts: 5 entries, 559 B, Mem0, updated 2h ago by AWP-272",
          "AWP-274 notebook: 1.5 KB, built-in, updated 2h ago by AWP-274"],
 "stores":{...},"items":[...],"nextCursor":null}
```

```json
{"summary":"3 matches for \"retry\" (run AWP-272). Searched Mem0, built-in and the record since 23 Sep.",
 "lines":["LEFT OUT Held, but left out of this run: the 16 KiB memory budget was full. \"Webhook sends are retried 3 times with exponential backoff\"",
          "OTHER STORE Only in built-in, which this run did not read (it used Mem0). \"Retry budget lives in WEBHOOK_RETRY_MAX\""],
 "groups":[...]}
```

## Accessibility

- **Colour is never the only carrier.** Every chip has its text label, and
  every dot on the rail sits next to a chip with a word.
- **Contrast.** Tones use the DESIGN.md tokens. Text on white is neutral-500
  or darker; neutral-300 or lighter is never used as text.
- **Card structure.** The card is a `section` with the CkCard `h3`. The beats
  are a `<dl>` (`<dt>` KNEW, `<dd>` sentence). The store role table is a real
  `<table>` with `<th scope>`.
- **Disclosures.** Each is a `button` with `aria-expanded` and
  `aria-controls`. When one opens from a count, focus moves to the first
  matching row, which gets `tabindex="-1"`.
- **The rail** is an `<ol aria-label="History of this entry">`. Each item
  carries its time as `<time dateTime>`, and each rail item reads as a full
  sentence without the visuals.
- **Search** is a `<form role="search">` with a visible label ("Search
  memory"). The result count is announced through `aria-live="polite"`, once
  per completed search.
- **Live run.** While a run is live, the card announces only changes of beat
  state ("Learned: 1 learned") through `role="status"`, never on every poll.
- **Modals** use the existing Modal primitive: focus trap, Escape closes, and
  focus returns to the control that opened it. Destructive modals put initial
  focus on Cancel.
- **Targets.** Every control is at least 24 by 24 px (WCAG 2.2 target size).
  Disclosure headers on phone are at least 44 px tall.
- **Motion.** No new motion. The pulse stays only on a live run's chip.
  `globals.css:301` sets the motion tokens to 0 under
  `prefers-reduced-motion`; stage 9a checks that the chip's pulse stops
  there too, and makes it stop if it does not.
- **Language.** Sentences are plain English, one idea each. Ids appear only
  in meta lines. A screen reader hears "from AWP-270", not "wrun_01M3...".

## What the UI stages must prove

Stage 9a covers the run page: the card, the replay strip and the Briefing
sections. Stage 9b covers `/memory` and Integrations.

**Render tests.** Both stages prove behaviour with `node:test` plus
`react-test-renderer` over fixture DTOs (house pattern, plan A3) and then in
the production browser.

**Viewports.** Desktop is 1280 by 800. Phone is 390 by 844 (in Orca:
`orca exec --command "set viewport 390 844"`).

**Orca note.** Recon found that `click @ref` did nothing on table rows and
replay pills. Navigate by URL, or use JS `.click()`, and record which one you
used.

**Render tests (every state row above has one).**
1. One test per state row in sections 1 to 11. Each asserts the exact copy
   from this spec (taken from the vocabulary module, not retyped), the chip
   label and tone, and which Disclosures are open by default.
2. Vocabulary exhaustiveness: every code in the ledger code list and the
   verdict list has a chip, a tone and a sentence. An unknown code renders
   as itself with the DTO sentence.
3. Null handling (Q4): every `number | null` field fed null renders
   "unknown" plus the reason, and never "0".
4. Links (Q7): in a card fixture with 3 tickets and 2 runs, every ticket key
   and run id in the text is inside an anchor with the right `href`
   (`runHref`, TicketLink, the entry anchor).
5. Count opens entries (Q3): clicking "3 left out" opens Given and focuses
   the first left-out row.
6. Replay: a fixture with a `run:repo-memory-distill` attempt shows the
   "Memory learning" pill. `?node=run:repo-memory-distill` stays selected,
   and the send count equals the number of reachable sends.
7. Forget and copy Modals render every list the preview fixture returns, and
   the refusal path swaps in the fresh preview.
8. `pnpm run gate:ui-primitives` green, and a raw-hex grep over new and
   changed memory files is empty.
9. Each key test is seen red once. For example: remove a left-out row, or
   hard-code "0" for null. The test that should catch it must fail.

**Browser checks on production, desktop and phone.**

| Check | Page and data state | Pass when |
|---|---|---|
| B1 Before the ledger | Run `wrun_01M37308WW9TM8NWNJXHEJNZ8C` (AWP-272) and `wrun_01M370G53QGVJ165KEG1A0D2TQ` (AWP-271), both before 6a | The card shows NOT RECORDED with the `predates_ledger` sentence and a working Briefing link. The replay shows the "Memory learning" pill, and its Briefing opens the 5.1 KB distill input. |
| B2 Complete record | The first def 14 ticket run after 6a (its run id is recorded in the 6a proof) | The four beats are filled in, with counts equal to the `runs.memory` MCP answer for the same run (Q6). A Given entry links to its `/memory` anchor, and that anchor highlights the row. |
| B3 Ranked | Ticket B after 6b (stage 6b DoD) | Given says "ranked by ticket text". Rows carry scores, and B's topic sits above the unrelated one. |
| B4 Skipped | Any failed or unpublished run after 6a | Learned shows the matching SKIPPED sentence. |
| B5 Five seconds (Q1) | B2 at 1280 by 800 | The header and four beats are visible without scrolling (screenshot saved). |
| B6 `/memory` first screen | `/memory` with production documents: `aiw-checks-fixture` facts (5) and lessons (1), `ai-workflow-demo` facts (4), notebook `AWP-274` | Desktop: the store panel and at least the first document row show without scrolling. Phone: the search input and the first document row show within the first screen. Subjects read `Blazity/aiw-checks-fixture` in full. |
| B7 Legacy notebook | `AWP-274`, before and after the 6a sweep | LEGACY chip "not yet moved", then "moved". It renders as prose with a "Human decisions" block, and the MCP client is shown by name. |
| B8 History and forget preview | The `aiw-checks-fixture` facts document after 6a | The rail shows learned and changed rows with run links. The forget preview names the Briefing runs, and Cancel leaves the entry untouched. Nothing is forgotten on production except on the fixture repo, and only with Filip's go-ahead. |
| B9 Search drill (Q2) | A fact from `aiw-checks-fixture` and a run that did or did not get it | From the run page to a verdict: 3 interactions or fewer, under 60 s, timed and recorded. |
| B10 Timeline and switch | After the stage 12 switch (A7, from Filip's session) | Two SWITCHED rows name Filip, built-in shows as IN USE, and Mem0 shows as NOT IN USE and is readable. |
| B11 Integrations | `/integrations/mem0/connection` | The health and pinned-count lines render. Press the availability switch only after reading `connection-screen.tsx` confirms that it opens a preview without writing; then check the preview text and cancel. |
| B12 Phone layout (Q8) | Every page above at 390 by 844 | JS: `document.documentElement.scrollWidth <= innerWidth`. JS: no element inside a memory section or Briefing section title that holds more than 3 characters of text is narrower than 64 px. |

**Positive controls.** Every JS check that returns "nothing found" must
first flag a known-bad page. Before the SendView fix, run the letter-wrap
check on today's production Briefing at 390 px: it must flag "Runtime data".
A clean result with no control proves nothing.

**Fixture-only states.** These cannot be produced safely on production, so
render tests cover them and the stage report names them as not observed
live: key rejected, quota, rate limit, timeout, two stores on, store changed
mid-run, record incomplete, first connect with empty Mem0, disconnected,
another project's key, a partly done forget or copy.

## Judging record

Scores are 1 to 10, higher is better. For cost, higher means cheaper to
build.

| Criterion | A: diagnosis first | B: story of a run | C: operator first |
|---|---|---|---|
| (a) Time to answer "why didn't it remember X" | 9 | 8 | 7 |
| (b) Five-second comprehension of a run | 7 | 9 | 8 |
| (c) Operator confidence on switch, forget, copy | 7 | 8 | 9 |
| (d) Fit with DESIGN.md and primitives | 7 | 8 | 7 |
| (e) Implementation cost (higher is cheaper) | 6 | 6 | 7 |
| **Total** | **36** | **39** | **38** |

**Why the scores.**
- **A** has the sharpest search: its verdicts are relative to a run, and its
  no-match sentence explains the learning history. But its run card puts a
  text input inside the summary, which competes with the reading. Its
  follow-the-id-chain search and its separate document route add cost.
- **B** tells the run as Knew, Given and Learned with counts first, which is
  the owner's "see at a glance what is going on". Its forget modal is the
  most honest (it quotes the text and names the runs), and it splits pinned
  runs into running and waiting. Its master-detail on desktop means two
  layouts, which costs more.
- **C** is best for operators. The store panel as a table of roles encodes
  D8, and the copy has a plan hash. Forget warns about a run learning now,
  and C adds the access-line link and the other-project key case. It loses
  on fit: it colours normal removals and rejections as failures, and it
  strikes through old text.

**Winner: B**, as the base, because the owner's bar is readability of what
memory did.

**Grafted from A.**
- Search verdicts relative to a run (`learned_after`, `sent`, `left_out`),
  and the no-match sentence with learning context and the ledger start date.
- The subject naming rule (never the truncated key).
- The "Before the ledger" state copy.
- "Forgotten. A run may learn it again." after forget.
- The run-level sends strip placement.

**Grafted from C.**
- The store panel as a role table, with the ALWAYS row for notebooks and
  routing.
- The access-line segment linking to `#memory`.
- The copy plan hash and "changed since the preview".
- "1 run is learning now and may learn it again" in forget (E19).
- The key-for-another-project confirmation (E27).
- The chip column in the vocabulary, and the vocabulary module in
  `packages/contracts`.
- The detail that replaces the list with filters kept.
- The "Memory learning" name.

**Conflicts resolved.**
1. **Card position.** After AnswerPanel and before the analysis report (A,
   B), plus C's access-line link. The report is long; memory is a primary
   question.
2. **Search from the card.** A link that lands in a focused, run-scoped
   search (B, C), not an input inside the card (A). The card stays four
   lines; the drill is still three interactions.
3. **Tones.** Warn for left out, not stored, redacted, cut and kept old.
   Failed only for a store that failed or refused. Neutral for normal
   removals (A, B). C's failed tone on removals would teach people to ignore
   red.
4. **Store panel.** C's table of roles, filled with B's health fields.
5. **Detail layout.** Replaces the list at every width (C), not
   master-detail (B). One layout, room for entry text, and deep links work
   the same on phone.
6. **Where the switches live.** A Settings RouteTab (A, B), not a closed
   disclosure at the bottom (C). It is linkable, and the header status line
   still says on or off.
7. **Search placement.** An input in the page header (A, B) that submits to
   a Search RouteTab (C). It is prominent, and the results have a URL.
8. **Updates.** "Was" and "Now" in body text. This is none of the three:
   DiffView is mono, raw hex and line based, and strike-through (C) hides
   the old text people need to read.
9. **Vocabulary home.** The `packages/contracts` module (C). The worker
   sends `sentence` on every row (B), and the dashboard falls back to the
   code (the house convention). This gives one source and survives version
   skew.
10. **MCP text.** `data.summary` and `data.lines` first in the existing JSON
    envelope, instead of A's free-text line before the JSON. The server
    always sends JSON text today.
11. **Search over forgotten entries.** A and C both promised a FORGOTTEN
    verdict from a word search, which Q2 (text blanked) makes impossible.
    Here only an exact phrase can match, by hash, and the no-match sentence
    counts forgets.
12. **Units.** Sizes use the Briefing's `formatBytes`, so a card size equals
    the Briefing section size. Limits keep their code names (16 KiB,
    256 KiB).

**Things noticed outside the three designs.**
- DiffView and the CkChip warn tone carry raw hex.
- The Mem0 Disconnect line contradicts the disable preview.
- `/integrations` "Served by Mem0" hides the built-in notebooks and routing.
- The SendView badge squeeze hurts every section on phone, not just memory.
- D3 has no code for deleting a notebook document.
- The `/memory` switch copy promises the notebook is "always hydrated and
  persisted".
- Three more local Disclosure copies remain after the promotion.

## Out of scope

- Semantic search on `/memory`: it spends Mem0 quota and makes the verdict
  depend on the model.
- Editing an entry's text. Forget it and let a run learn it again; editing
  would break provenance.
- Bulk forget, and forgetting across repositories in one action.
- Retrying items lost to an unavailable store. The ledger keeps them, so it
  can come later.
- Scrubbing Briefings on forget (Q2).
- A chooser when two stores are on (E8 keeps the refusal).
- A quota meter: Mem0 does not report quota to us.
- Auto-refresh on `/memory`. The run card refreshes only with the run page's
  existing live poll.
- Charts, dark mode (DESIGN.md is light only), and notebook editing.
- Lessons from failed runs (the plan's out-of-scope list).
- Replacing the three other local Disclosure copies and the repository
  Memory tab's raw reds (`repository-entry.tsx:914,963`). These are noted
  debts; stage 9 touches them only if it edits those files.
