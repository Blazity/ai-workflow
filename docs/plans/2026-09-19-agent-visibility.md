Status: draft
Last-verified: 2026-09-20

# Agent visibility: see exactly what an agent was given, and give it the whole repository map

Planned on 2026-09-19 from a read-only recon of `main` at
`57dc151bbadadffebafceec7768f669b1dd6d0ed` (production runs the same commit).
It replaces the unmerged draft of 2026-09-18 ("Agent briefing"), keeps its
decisions and its capture-path spike
([research/2026-09-18-agent-briefing-capture-path.md](../research/2026-09-18-agent-briefing-capture-path.md)),
and changes three things the owner asked for on 2026-09-19: the feature lives
in its own package, the prompt composition is cleaned up first so every piece
of text a model gets has a name and an origin, and the Repository Map is half
of the goal rather than a follow-up.

The owner's words: "The dashboard has to show everything: the whole prompt,
which decisions the agent got, the answers, per round. MCP returns exactly the
same. Without that nobody can debug this." And about repositories: "The agent
should get what is what and not have to look for it. It should have the whole
dependency map up front, smoothly, and be able to check it, rather than work
out on its own what is related and why." And about the code: "Clean. Separated
in the code, wired in properly, not held together with tape."

## Problem

A person looking at a run cannot see what the agent was given, and the agent
is not given what the product promises.

- The compiled prompt exists only as a file in the ephemeral sandbox. The run
  keeps a manifest of prompt-library references and nothing a person can read.
  The compiler builds the prompt from named sections with provenance
  (`packages/prompts/effective-prompt.ts:135-142`) and the engine throws them
  away (`engine/agent-workflow.ts:4195`).
- Everything the run contributes (ticket, comments, clarification answers, PR
  threads, CI, selected repositories, our own rules such as the Repository
  Access Protocol and the Resolution Check, refusal and "expansion closed"
  notes) is one `runtime` blob (`sandbox/context.ts:87-363`,
  `agent-workflow.ts:2770-2829`). The decisions a person most needs to see are
  inside it, unattributed. Our rules sit inside the data, so a profile with
  `includeWorkflowData` off loses them together with the ticket
  (`agent-workflow.ts:4167`).
- The Repository Map (`engine/work-scope/map.ts:45`) has no production caller;
  `CONTEXT.md:62-64` says it is rendered into the agent's context, which is
  false. The trigger policy "the event repository and its related
  repositories" never adds a related repository, because `eventRelatedKeys` is
  always empty (`engine/work-scope/context.ts:268`). Discovery describes
  repositories with the GitHub or GitLab listing text
  (`engine/repository-discovery/catalog.ts:188`), not the operator's profile.
- Research and implementation render "Selected repositories" from different
  objects (`sandbox/context.ts:89` versus `agent-workflow.ts:3302`).
- The Work Scope and the clarification rounds are served by the worker and
  shown nowhere in the dashboard; an unclear reading overwrites the stored
  answer (`db/repositories/clarification-hooks.ts:300-310`), so the history of
  a round is lost.
- The replay sanitizer's phone pattern (`run-observability/sanitizer.ts:493`)
  masks cost decimals and the date suffix of model names
  (`claude-sonnet-4-5-20250929`), so anything built on it is shredded.

The cost on production: a planning attempt asked again and again for
repositories the person had left out, or that nobody enabled, until expansion
closed and the run failed after eleven minutes; the only way to see why was a
truncated log pulled through MCP.

## Solution

1. **Every piece of a prompt has a name and an origin.** The compiler composes
   the run's contribution as ordered, named parts (ticket, comments,
   clarification answers, PR threads, CI, Work Scope notes, research notes),
   and our own rules are parts of origin `platform` where they stand today.
   Discovery composes from the same parts. The text a model receives does not
   change, except for one declared fix (a false label).
2. **Every send is recorded as an Agent Briefing.** Discovery, every pass of
   every agent block, and `call_llm` / `investigate` blocks: the prompt exactly
   as sent, section by section with origin, the repository context it rendered,
   and the harness extras (model, output schema, skills delivered). Redacted
   once, stored once, read by the dashboard and MCP through one read model.
3. **Every repository question is shown as a Clarification Round**: what was
   asked, every delivery of an answer with its reading and the note posted
   back, and what the record did with it.
4. **Every agent that works on repositories gets the Repository Map**, ranked
   by relationship, with the operator's descriptions, relationships and each
   repository's state for this work (write, read only, offered, excluded,
   disabled with its reason). Repositories related to the ones a ticket or
   event names become candidates the run may take without asking, within the
   trigger's expansion rule. The map is a section of the briefing, so a person
   sees exactly the map the agent got.
5. **Planning works within the record.** It plans with what it has and names
   what is missing; asking again for a repository this run already refused
   stops the run at once with the same message.

## Users and situations

- **The owner or a developer debugging a failed or odd run**, on a desktop,
  often from a Slack or Jira link, wanting to know "what did it get, and why did
  it decide that". Arrives with a run that already finished or failed.
- **The same person on a phone**, opening the ticket link to check a round
  before answering in Jira.
- **Someone who only has Jira** (a reporter or a PM) whose answer was read in a
  way they did not mean, and who needs a way back that is not an API call.
- **An MCP client** (a Claude Code session) debugging a run without the
  dashboard, with a result size cap of 524,288 bytes per call.
- **An operator who wrote repository descriptions and relationships** and wants
  to verify the agents actually receive them.
- **A person opening a run from before this shipped**, or an attempt that failed
  before its prompt went out, or one still preparing.

## User stories

1. As a person debugging a run, I open a Block Attempt and read, pass by pass,
   the prompt the agent was sent, each section with where it came from.
2. As that person, I see which repositories the agent was told about, with the
   description it saw and whose description that was, the relationships, the
   rules, and each repository's state for this work.
3. As that person, I can tell our own rules (origin `platform`) from the run's
   data, and a research note from a ticket comment.
4. As that person, I see the harness extras: model, output schema, skills.
5. As a person looking at a ticket, I see its repository record and each
   repository question as a round with every delivery, reading and note.
6. As a person with only Jira, I can correct the record from the ticket page:
   select, exclude, undo a choice the workflow made.
7. As an MCP client, I get the same briefing and rounds, in pages under the cap,
   byte for byte what the dashboard shows.
8. As a person looking at an attempt with no briefing, I am told why: not sent
   yet, never sent (with the recorded failure), or not recorded.
9. As an operator, I see in the flow editor the last real briefing a block
   produced, next to the authoring preview.
10. As an operator, I trust that configured secrets never appear in a briefing.
11. As an agent working on repositories, I get the whole map up front with what
    each repository is for and how they relate, and I am not asked to
    rediscover it.
12. As a person whose ticket names repository A, where A is `frontend_for` B, I
    see B taken as a candidate without being asked, and the briefing shows why.
13. As a person who excluded a repository, I never see the run ask for it again,
    and I never see a run die retrying it.

## What good looks like

It feels right when a person can answer "why did the agent do that" from the
briefing alone, without MCP log archaeology, and when an operator can point at
the exact line of the map where the agent was told that A is the frontend for
B. It merely passes if the prompt is stored but shows up as one wall of text,
if the dashboard and MCP disagree by a byte, or if an empty tab says "not
recorded" when the truth is "never sent".

## Implementation decisions

**Module shape: visibility records, never composes.**

- `packages/agent-visibility` (new, pure, source entry, imports only
  `@shared/contracts` by the default edge in `scripts/gates/tiers.json`). It
  owns the Agent Briefing contract (record, section, repository context
  including the map, Clarification Round with deliveries, missing-briefing
  reason, `schemaVersion`) and the pure functions over it: build a stored record
  from sections plus context with the sanitizer and budget passed in, page a
  section, derive why a briefing is missing, assemble rounds from rows. Two
  consumers: the worker and the dashboard (ADR-001:79-84). Precedent: the
  `workflow-graph` package and its worker half. The paused contract work
  (`packages/contracts/agent-briefing.ts` on the old branch, commit `43810eb8`)
  is its starting material, not its shape.
- `packages/prompts` stays the only place prompts are composed. Visibility does
  not import it: the worker's capture adapter maps a compilation to the
  package's input, so neither package knows the other.
- `apps/worker/src/services/agent-visibility/` is the one worker cluster with
  one `index.ts`: record a briefing, record an answer delivery, list briefings
  of an attempt, read a section page, read the rounds of a subject. Storage in
  `db/`, surfaces in `routes/` and `mcp/tools/` stay thin.
- The engine has one hook per send: the compilation travels to the send step as
  data, and the step records it. No worker-only shape leaks into
  `packages/workflow-graph`; if the shared seam type forbids returning the
  compilation, the worker's own per-invocation context carries it.

**Prompt composition (stage 2).** `runtimeData: string`
(`packages/prompts/effective-prompt.ts:113`) becomes an ordered list of parts,
each with a stable id, a title, content and an origin; the section kinds stay
as they are. Our rules (the Repository Access Protocol, the Resolution Check,
the remediation framing, the output-format patch) become parts of origin
`platform` with a code id, in the position they have today. Discovery composes
its prompt from the same part type and returns its parts. The rendered text
stays byte-identical for every send kind, with one declared change: the false
"Pre-Sandbox" label on mid-run notes (`sandbox/context.ts:503-507`). Changing
order, wording, or what a profile with `includeWorkflowData` off receives (it
loses our rules together with the ticket today) is not this stage: the last
one is recorded under Out of scope for an owner decision.

**One briefing per send, not per attempt.** The planning block restarts inside
one attempt (`agent-workflow.ts:2629`, restarts at `:2705`, `:2942`, `:3005`,
`:3034`), and the notes that explain a failed planning run exist only from the
second pass. A briefing is keyed by run, node, attempt, activation scope and a
sequence number, and carries the pass label `researchPhaseIdentity` already
produces (`engine/blocks/support/types.ts:496-537`). The sequence is ONE counter
per Block Attempt shared by every kind, in the order the sends really happen,
so separate counters cannot collide and make one insert silently do nothing.
Discovery belongs to whichever Block Attempt sent it: with a `prepare_workspace`
node, which is the production shape, that is that node's own attempt
(`agent-workflow.ts:2607-2611`); on the lazy path it is the planning attempt
(`:2719` calls `ensureCodeWorkspace`, which discovers at `:2460`). Both shapes
record. The insert checks what it wrote and logs a conflict.

**Capture path (from the spike, re-verified on `main`).** One optional trailing
argument on the existing send steps (`writeAndStartPhase`,
`engine/steps/phase.ts:468-558`; the generic and fix agent start steps), and a
best-effort insert inside the step body modelled on
`engine/work-scope/apply-plans.ts:38-63`. `call_llm` and `investigate` already
carry their prompt as a step argument and record inside their step. No new
`"use step"`, no step renamed or moved. The Workflow DevKit matches journal
entries by correlation id, never by arguments (spike §3), so the change is
safe for runs in flight; a send created but not completed across a deploy has
no briefing and says so.

**Capture never fails a run.** A failed write logs `logger.warn` with run and
attempt and the agent starts exactly as today (`phase.ts:559` keeps
`maxRetries = 0`). A setting switches capture off; because the workflow body
reads settings frozen at run start, it is honestly `appliesToRunsInFlight:
"next run"` and stops the next run, not one in flight. It is on by default, so
data accumulates from the first deploy. The row is written after the prompt
file exists in the sandbox and before the detached command starts
(`phase.ts:507-540`): writing it after the launch would leave a window in which
a person is told "never sent" about an agent that is already working.

**Section text is what was sent.** A section's text is the exact bytes between
its sentinels as sent. The compiler rewrites sentinel characters and NUL and
cuts a section at 200,000 characters (`packages/prompts/effective-prompt.ts:144`,
`:691`, `:703-707`); after stage 2 that handling happens per part, and a part
the cap removed or shortened is marked as cut before sending. "Cut before
sending" and "truncated for storage" are different fields, because the first
changes what the agent got and the second only what we kept. Byte ranges of
parts are computed by the visibility builder after redaction, never passed in.

**Record what was rendered, never reconstruct.** The structured repository
context comes from the exact inputs the renderers used for that send. Nothing is
re-read from the catalog at capture or read time.

**One redaction, at capture.** Stored text is already redacted, so the
dashboard and MCP show the same bytes, a sha256 covers them, and each redaction
is stored as a span so the page can mark where text was removed. Configured
secrets, the secret names the configured-secret pattern misses (`DATABASE_URL`,
`WEBHOOK_TRIGGER_ENCRYPTION_KEY`) and credential shapes are always removed.
Whether personal data is removed too was reopened by the pre-mortem: the replay
sanitizer's personal-data rules mask dates, timestamps, IP addresses and epoch
milliseconds as phone numbers, and the module calls itself presentation-only
(`run-observability/sanitizer.ts:310-316`, `:476`, `:493`); see Assumptions.
The phone pattern is fixed for the replay and logs either way, with tests on the
real false positives. The prompt is already journaled unredacted as a step
argument today (`sandbox/agents/redact.ts:10-12`); the briefing neither widens
nor fixes that.

**Serving is the identity.** MCP rewrites every string at serve time (ANSI and
control characters, bearer and `gh*_` tokens, lone surrogates:
`mcp/sanitize-result.ts:46-66`). Capture normalizes stored text so that this
function leaves it unchanged, recording each normalization as a redaction span
of its own kind, so the dashboard and MCP really do show the same bytes. The
sanitizer the worker injects returns the positions it changed; the builder never
diffs strings (a Jira comment may quote a literal `[REDACTED:...]` marker).

**Budget.** Up to 512 KB per briefing. Over budget, sections with provenance
(harness instructions, AGENTS.md, memory) are cut first and keep their identity;
run data is cut last. A cut section keeps its original size and hash.

**Storage.** `agent_briefings` (identity, kind `discovery | agent | llm`, the
index, bytes, created at; unique on identity plus sequence;
`INSERT ... ON CONFLICT DO NOTHING`). Section texts are stored once, addressed by
their sha256, because every planning pass repeats the ticket, the comments and
the map; the structured repository context is stored the same way, and the
index itself has a hard size bound. Stripped control characters (a CI trace can
carry thousands) are counted per part rather than stored as spans. A separate
`agent_briefing_runs` row outlives the briefings and records what a run's
capture did, so "no briefing" can be told apart from "this code could not
capture". `clarification_answer_deliveries` keeps each distinct delivery (words
as delivered, who, via which surface, the reading, the note posted back) with a
repeat count and first and last time: the Jira path re-composes the answer from
the ticket's comments on every poll tick (`answer-core.ts:502-505`), so a
delivery per tick would bury the round. Additive migration `0070`; stage 6 adds
`0071` for the new work scope origin. neon-http has
no transactions: every write is one statement, and a briefing is never visible
without its texts. Briefings are swept beside the run's replay observations
(30 days, `poll-pass.ts`), and a briefing's own expiry is the LATER of the
run's replay expiry and thirty days from its send, so a send made by a run
parked past its replay is not born expired. Delivered that way: the sweep
deletes only once both have passed, which means a late send outlives the
replay that no longer reaches it.

**Why a briefing is missing**, derived from the attempt: not sent yet (still
preparing), never sent (failed before sending, with its recorded failure), not
recorded (the attempt ran on code from before capture, told by the code version
the attempt ran, not by a date, because a run pinned to an old deployment can
start attempts long after the deploy; or capture was skipped or switched off),
or expired with the replay. Never a generic message. Attempt rows carry no code
version today and are deleted with the replay, so the worker records, per run
and durable past replay expiry, whether the code the run executed could capture
and whether capture was switched on; an unknown answer reads as "predates
capture". A read of an attempt row that still says running on a failed or
cancelled run never says "not sent yet". Whether the prompt went out is decided first
(from whether the attempt's send step completed, when that is known), and only
then whether we kept it: a run that failed while preparing says "never sent"
with its failure even when capture was off or the code predates it.

**Rounds.** A round is the question, every distinct delivery with its count,
and the Decision Trail events of that clarification. A question asked again
after a retry shows as asked again, not as a new round.

**Routes and MCP, settled before the dashboard starts.** Briefings are
addressed by run, not through the replay attempt route, which returns nothing
once a replay expires (`run-replay-read.ts:140-143`):
`GET /api/v1/runs/{runId}/briefings` (the overview of every briefing of the
run, filterable by node, attempt and activation scope; per Block Attempt its
briefings, a missing-briefing reason computed even beside existing briefings (a
planning attempt that captured discovery but whose pass never went out), and
whether the block sends prompts at all, decided by the worker from the block
type, so a script block never reads as "not recorded"); under
`/api/v1/runs/{runId}/briefings/{briefingId}`: `sections` (section headers),
`sections/{index}` (a page of one section's text by offset and limit),
`sections/{index}/parts` and `sections/{index}/spans`, `repository-context`
(its repositories paged) and `unresolved-sources` (what the compiler referenced
and could not find). `GET /api/v1/work-scope` gains round headers, with
`rounds/{roundId}/deliveries` and `rounds/{roundId}/effects` paged, and
`GET /api/v1/workflow-definitions/{id}/nodes/{nodeId}/last-briefing` answers
the flow editor. MCP `runs.briefing`, `workflows.node_briefing` and
`work_scope.get` mirror them.
Every result is paged: section text, the repository context and the rounds.
Structured items are never cut to fit: the package serves small headers (a
briefing overview, section headers, round headers) and each growable child list
(parts, repositories, deliveries, redaction spans) as its own cursor-paged list.
The default page is about 48 KB, below the default output limit of MCP clients
(Claude Code saves a larger result to a file instead of showing it), and a
caller may ask for more up to `MCP_MAX_RESULT_BYTES`, above which the server
replaces the whole result with a digest (`mcp/sanitize-result.ts:130-142`).
`work_scope.get` gains rounds without ever crossing the cap, so the record it
returns today is never lost to a digest. A parity test compares route and tool
on a briefing larger than the cap. Every dashboard view has its tool.

**Repository Map (stage 6).** One renderer replaces both "Selected
repositories" lists. It is ranked by relationship and bounded, because a
catalog field may hold 20,000 characters (`packages/contracts/repository-catalog.ts:43`)
and a section is cut at 200,000, which would silently remove our `platform`
rules that follow the map. The whole dependency neighbourhood gets full
entries: repositories the ticket or event names, the attached ones, and their
relationship neighbours, each with the operator's description (the provider's
listing text only as a labelled fallback), relationships, and its state for this
work with its reason, including disabled and not enabled ones marked "do not
request". Every other catalog repository gets one line; above a limit, a count
and "ask by name". Descriptions and rules are rendered once, not in both the map
and the repository section. Discovery and every repository-working agent get
it. `eventRelatedKeys` is filled from the relationships of the repositories a
ticket or event names. Every repository in a briefing's context carries why it
is there (named, attached, related via which repository and relationship,
offered, and so on), and readers tolerate a cause or state they do not know,
because the worker and the dashboard deploy separately.

**Access and retention.** Whoever can open a run reads its briefings, the same
audience as its logs. Retention as Block Attempts. Delivered that way, which
widens what an existing credential reaches: `runs.briefing` and
`workflows.node_briefing` carry the ordinary MCP read scope
(`mcp/policy.ts:497-498`), so a token minted months ago for dispatch now also
reads ticket bodies, `AGENTS.md` and the memory a run was given. Nothing new
has to be granted and nobody holding such a token was asked, so an operator who
minds reviews the tokens they have out.

## Open to the executors

- Internal structure of the package and the worker cluster, file names, helper
  names.
- The exact list of part ids and origin kinds, as long as every byte of runtime
  text belongs to exactly one named part.
- How the compilation reaches the send step, within the constraint above.
- Table columns beyond the identity, as long as the contract round-trips.
- The dashboard layout, copy, states, how passes and sections are navigated, how
  the repository context and the map read, the phone layout, and how the edit
  controls confirm and undo. DESIGN.md binds the visual language.
- Map wording and ranking details, as long as the map is deterministic and
  every state has its reason.

## Seams and test decisions

| Seam | What we observe through it | Prior art |
|---|---|---|
| Visibility package | a record built from a real compilation parses under zod 3 and zod 4; malformed input is refused; over budget, provenance sections are cut first and run data last; pages reassemble to the stored text; each missing reason from its attempt state; two unclear deliveries and a clear one assemble into one round | `packages/contracts/work-scope.ts` tests, `packages/workflow-graph` |
| Prompt compiler | the same inputs render the same bytes as before for every send kind (golden fixtures captured before the change), except the declared label fix; every runtime byte belongs to one named part | `packages/prompts/effective-prompt.ts` tests, `engine/helpers/effective-prompt.parity.test.ts` |
| Sanitizer | real false positives (cost decimals, model date suffixes) survive; real phone numbers and secrets do not | `run-observability/sanitizer.ts` tests |
| Storage and deliveries | a briefing insert is one statement and idempotent on its identity; every answer delivery appends a row, including unclear ones | `db/repositories/work-scope.ts`, `services/clarifications/answer-core.test.ts` |
| Capture | a planning attempt with three passes writes three briefings in order; discovery writes one; `call_llm` writes one; a failed insert logs and the agent starts | `engine/steps/phase.ts` tests, `engine/work-scope/apply-plans.ts` |
| HTTP and MCP | route and tool return the same bytes, including a briefing over the MCP cap; each missing reason | `mcp/tools/work-scope.ts` tests, `mcp:contract:check` |
| Dashboard | every pass, section, origin, map and round visible; each empty state; desktop and 375 px | `workflow-replay.tsx` tests |
| Repository Map | ticket names A, A is `frontend_for` B: the briefing's map shows A and B related, B is a candidate without a question; a disabled repository appears with its reason | `engine/work-scope/map.test.ts` |
| Planning within the record | ticket names four, person picks one: planning plans within the one and names the three left out, no failed run; a repeated request for a refused repository stops the run at once with the same message | the planning expansion tests in `engine/` |
| PR feedback predicate | with a ledger and with flat comments, the prompt and the no-change gate agree on whether feedback is pending | `engine/review-ledger` tests |

## Out of scope

- The harness CLI's own system prompt and tool definitions.
- Prompt governance: ownership, approval, rollback across the prompt library,
  profiles and catalog. A separate project.
- Removing the duplicated source of built-in prompts (code constants and
  library rows pinned `@1`): it needs a data migration and an owner decision.
- Enforcing that an agent sees only bound data (the sandbox data-leak backlog
  item). Stage 2 makes it possible; it is not done here.
- Changing what a bound `prompt` input does to a block's authored prompt.
- Whether a profile with `includeWorkflowData` off should still receive our
  `platform` rules; stage 2 reports which profiles set it and the owner decides.
- What the agent did inside the sandbox (its transcript). Phase 2 of this
  feature, in the same package, after its own spike: it needs a different CLI
  output format and storage sized in megabytes per run.
- A declined answer ("none") ending the run red with a second comment.
- Whether harness profile home files are read by the CLI at all (spike §8.2):
  checked on a real CLI, fixed separately.

## Assumptions

- The byte-identical refactor is achievable, including discovery. If a send
  kind cannot keep its bytes, the executor stops and asks rather than accepting
  drift.
- Storage per briefing: up to 512 KB of section text, an index bounded at
  512 KiB and a repository-context document bounded at 1 MiB, so a first pass
  can reach about 2 MB in the worst case; later passes of the same attempt share
  texts and the context document by sha256 and add little beyond their index.
  Acceptable on Neon at today's volume; revisited after the first production
  sizes.
- Deployment pinning of in-flight runs is read from the SDK, not observed (spike
  §8.1). Stage 3b checks it once. If pinning holds, a run parked across a deploy
  keeps its old code, so "predates capture" is told by the attempt's code
  version, and production proofs use runs started after the deploy.
- Production proof runs on the cheap haiku profile for recording checks and on
  the built-in opus profile only for the planning and map behaviour proofs
  (owner approval, 2026-09-19).
- Each group of stages ships as its own pull request, merged only with the
  owner's consent, because `main` deploys production. While the engine canary
  is red for lack of OpenAI credit, a merge needs the owner's explicit consent
  to bypass it, recorded in Jira as ADR-004 requires (on 2026-09-18 that was a
  comment on the credit incident issue), every time. Pull request B ships
  capture before C ships a reader; capture is on by default so data
  accumulates, and its setting switches it off for the next run.
- `CONTEXT.md` edits are coordinated with the parallel integrations session,
  which also edits it.

## Stages

Pull requests: A = stage 2. B = stages 1, 3a, 3b. C = stage 4. D = stages 5,
5b, 5c. E = stage 6. F = stage 7. G = stage 8. Each carries its own entry in
`changelog/unreleased/`. Stage 9's documents ride with the pull request they
describe; stage 10 closes.

| # | Stage | Seam | File scope | Tier | Autonomy | Skeptic | TDD | Delegation | DoD |
|---|---|---|---|---|---|---|---|---|---|
| 1 | A person's view of a send has a stable, validated shape | Visibility package | `packages/agent-visibility/**`; `scripts/gates/tiers.json`; root `package.json` test filters; `scripts/ci/verify-changed.test.ts` if it lists packages; `packages/AGENTS.md`; ADR-001 dated addendum; `pnpm-lock.yaml` | opus | tight | yes | yes | no | `pnpm run test:packages` and `pnpm run test:packages:zod4` include the package and pass; the dependency-cruiser gate fences it; `pnpm run typecheck` green |
| 2 | Every byte of a prompt belongs to a named part with an origin, and the model gets the same bytes | Prompt compiler | worktree `lanes/wt-prompt-parts`: `packages/prompts/**`; `apps/worker/src/sandbox/context.ts`; `engine/helpers/effective-prompt.ts`, `engine/helpers/resolve-agent-input.ts`; the composition regions of `engine/agent-workflow.ts` (research additions, implementation and review inputs, `compileInvocationPrompt`, discovery assembly); `engine/repository-discovery/runner.ts` prompt assembly; the addition shape in `pre-sandbox/steps/repo-selection.ts`; the composition regions of `engine/blocks/{generic-agent,fix-agent}/execute.ts`; `engine/blocks/support/types.ts` (the per-invocation context); `packages/prompts/prompt-authoring.ts` and the dashboard authoring preview where the `runtimeData` type forces it | opus | tight | yes | yes | no | an oracle (the assemblers and discovery composer as they are at the base commit, copied into test code) and the new code render identical bytes over a generated matrix of inputs (every optional input present, absent and empty; Polish text and emoji; a ticket containing the sentinel characters; a ticket over 200,000 characters), with branch coverage of the old functions as evidence, except the declared label fix; every byte of every section in exactly one part; `step-registration-coverage` and `workflow-import-boundary` green; the effective-prompt parity test green; typecheck green |
| 3a | Briefings and answer deliveries have somewhere to live, and redaction stops shredding numbers | Sanitizer; Storage and deliveries | `apps/worker/src/db/schema/` (new file plus its export); `apps/worker/drizzle/0070_*`; a new repository file under `apps/worker/src/db/repositories/`; `apps/worker/src/services/agent-visibility/` write half; `run-observability/sanitizer.ts`, `run-observability/configured-secrets.ts`; `services/clarifications/answer-core.ts`; the answer-surface wording in `engine/support/clarification-comment-format.ts` and the surface plumbing from `services/clarifications/answer-request.ts` and the MCP answer tool; the replay observation cleanup so briefings expire with it | opus | tight | yes | yes | no | migration applies in pglite; every write is one statement; sanitizer tests on the real false positives (costs, model date suffixes, dates, timestamps, IP addresses, epoch milliseconds); two unclear answers and a clear one read back as three deliveries; 200 identical poll ticks read back as one delivery with a count of 200; briefings of an expired replay are gone; typecheck |
| 3b | Every send records its briefing | Capture | `engine/steps/phase.ts`; the send steps in `engine/blocks/{generic-agent,fix-agent,call-llm,investigate}/execute.ts`; the send call sites in `engine/agent-workflow.ts`; `engine/blocks/support/types.ts`; `engine/agent-visibility/` capture adapter; the capture setting | opus | tight | yes | yes | no | every send kind, built from the real stage 2 compilation, records (outcome `recorded`, never a refusal marker); a planning attempt that plans three passes writes them in send order with its discovery recorded under the attempt that sent it, in both the `prepare_workspace` and the lazy shape; `call_llm` writes one; a ticket over 200,000 characters produces a briefing whose parts say what was cut before sending; the new step argument stays far under 64 KB for a 300 KB prompt; failed insert logs and the agent starts; capture switched off writes a marker per send and says so; step guards green; deployment pinning checked once against an observed deployment id |
| 4 | The dashboard and MCP can read briefings and rounds, byte for byte the same | HTTP and MCP | `apps/worker/src/services/agent-visibility/` read half; `routes/api/v1/runs/[runId]/briefings*`; `routes/api/v1/work-scope.get.ts`; `mcp/tools/` runs and work-scope tools, tool catalog, MCP contract | opus | tight | yes | yes | no | route and tool parity on a briefing over the MCP cap, every page under the default and under the cap; `work_scope.get` with rounds stays under the cap on a round with hundreds of poll ticks; each missing reason; `mcp:contract:check` green |
| 5 | A person sees every pass, section, origin, map and round, on desktop and phone | Dashboard | `apps/dashboard/**` replay Briefing tab, ticket Repositories panel, API client and proxy routes | opus | open | yes | no | yes (fixtures) | component tests; browser at 1440 px and 375 px, each empty state seen |
| 5b | Someone with only Jira can correct the record from the ticket page | Dashboard | the ticket Repositories panel in `apps/dashboard/` | opus | open | yes | no | no | select, exclude and undo through the existing edit endpoint, seen in the browser; the same edit through `work_scope.edit` |
| 5c | An operator sees the last real briefing of a block in the flow editor | Dashboard; HTTP and MCP | the flow-editor preview in `apps/dashboard/`; one worker read and its MCP tool (delivered with stage 4) | opus | open | yes | no | no | the preview shows the last briefing of the node or says why there is none; the authoring preview applies the selected profile's switches (a profile with `includeWorkflowData` off previews without run data, as execution sends it); route and tool parity |
| 6 | Every repository-working agent gets the whole ranked map, and related repositories become candidates | Repository Map | `apps/worker/src/repository-map/` (delivered as a move out of `engine/work-scope/map.ts`), `engine/work-scope/context.ts`; `engine/repository-discovery/`; `services/work-scope/record.ts`, `services/work-scope/from-answer.ts`; the selected-repositories renderer in `sandbox/context.ts`; related-key plumbing in `engine/agent-workflow.ts` | opus | open | yes | yes | no | ticket names A, A is `frontend_for` B: the briefing shows the map with A and B related, B taken without a question, and why; discovery shows the operator's description; a 150-repository catalog with 5 KB profiles keeps every `platform` part intact and the runtime section under the cap; proven on production |
| 7 | Planning works within the record and never dies retrying a refused repository | Planning within the record | planning loop and expansion paths in `engine/agent-workflow.ts`; `closedExpansionFailure` and `CATALOG_CANNOT_SERVE` in `engine/repository-discovery/runner.ts`; `engine/support/clarification-comment-format.ts` | opus | tight | yes | yes | no | ticket names four, person picks one: plans within the one, names the three, no failed run; repeated request stops at once with the same message, delivered whole; "select it" never said about a repository nobody enabled; the model is no longer told that older clarification rounds were omitted when only the newest round was shortened (found in stage 2, `sandbox/context.ts:549-579`) |
| 8 | Pending PR feedback means the same thing to the prompt and to the no-change gate | PR feedback predicate | `sandbox/context.ts`; the retry note and gate call in `engine/agent-workflow.ts`; `engine/review-ledger.ts` | opus | tight | yes | yes | no | with a ledger and with flat comments, prompt and gate agree; the earlier client regression shape stays fixed |
| 9 | The words and documents tell the truth | none | `CONTEXT.md` (coordinated), `docs/product/` and its roadmap statuses, `docs/index.md`; delivered wider: the ADR-001 addendum for the worker's homes, the four routing tables, `.claude/rules/agent-visibility.md`, `docs/architecture/data-model.md`, this plan's delivery record | sonnet | tight | no | no | no | `pnpm run gate:docs-status` green; roadmap items mapped to what shipped |
| 10 | Production proof | all | none | advisor | tight | no | no | no | on runs started after each deploy (a pinned run keeps its old code): every send of a definition 40 run has a briefing on the ticket page and through `runs.briefing`, same bytes; rounds match the Jira comments; the map, related-candidate and planning shapes proven on live tickets |

Order and parallelism: stages 1 and 2 start together (disjoint files, different
worktrees). Stage 3a starts after stage 1's gate. Stage 5 starts after stage 1's
gate on fixtures, on a branch stacked on stage 1. Stage 3b starts after stages 2
and 3a, because it passes the compilation stage 2 exposes and writes into
storage stage 3a builds. Stage 4 follows 3a in the same cluster. Stage 6 starts
after pull request B is on production, so its effect is visible in real
briefings; stage 7 follows 6 and stage 8 follows 7, because all three touch
`engine/agent-workflow.ts`.

## What landed, and where

Recorded on 2026-09-20. Stage 8 shipped after the first version of this
section was written and is listed below; stage 10, the proof on production,
is the only stage still open. The stages did not
ship as one line of commits, so this is the only place the whole feature is
listed. Every branch but the first carries a `changelog/unreleased/` entry;
stage 2 has none, because the only byte it changed for a model is the declared
label fix (a mid-run discovery or change-set note no longer claims to be
"Pre-Sandbox": `sandbox/context.ts`).

- **`refactor/prompt-runtime-parts`**, head
  `1be1ec06f6304ab04003967d1f2d406e9b181b49` (stage 2). `packages/prompts/prompt-parts.ts`
  turns the run's contribution into ordered named parts with an origin, and the
  pre-change assemblers live on as an oracle in
  `apps/worker/src/test-support/prompt-oracle/`, with golden bytes per send
  kind. Its worktree was `lanes/wt-prompt-parts`, which the stage table names.
- **`feat/agent-visibility`**, head `abd9a13279884658894d96c2bc2385afaa9301a1`
  (stages 1, 3a, 3b), contains the branch above. `packages/agent-visibility`,
  the `agent_briefings`, `agent_briefing_texts`, `agent_briefing_runs` and
  `clarification_answer_deliveries` tables (migration `0070`), capture from
  inside every send step, and the `ENABLE_AGENT_BRIEFINGS` setting.
- **`feat/agent-visibility-routes`**, head
  `e30b93b53fb6aa3a1b8f42fa80c9b0248fc8556a` (stage 4), branched from stage 3a
  and does **not** contain stage 3b. `apps/worker/src/services/agent-visibility/`,
  the briefing routes, the two rounds routes, the node last-briefing route, and
  the MCP tools `runs.briefing` and `workflows.node_briefing` (the contract goes
  from 44 tools to 46), plus `rounds` as an opt-in on `work_scope.get`.
- **`feat/agent-visibility-dashboard`**, head
  `04a14b0b86ba9dc41f386df3776a03a8dff99f24` (stages 5, 5b, 5c), branched from
  stage 1 alone and built against fixtures, so it contains neither the capture
  nor the routes it calls: **it has to merge after the routes branch**, or its
  proxy handlers address endpoints the worker does not serve. The Briefing tab,
  the ticket Repositories panel with record editing, the flow editor's last real
  briefing, and the authoring preview applying the selected profile's switches.
- **`feat/agent-visibility-map`**, head
  `2c243792f42c3fd72aa9aded464e93e398248cb8` (stage 6), contains
  `feat/agent-visibility`. `apps/worker/src/repository-map/` (moved out of
  `engine/work-scope/map.ts`), the ranked map in every repository-working send,
  `related_repository` as a work scope origin with its CHECK migration `0071`,
  and the map recorded inside the briefing. NOT in discovery: that step carries
  the same operator descriptions and relationship sentences row by row, and is
  deliberately not given the map, because at discovery time nothing is checked
  out yet and every row would read as "not in the workspace". Rule D6 in
  `docs/product/repository-record-behaviour.md` says so, pinned by the
  discovery golden.
- **`feat/agent-visibility-planning`**, head
  `03a5be5b` (stages 7 and 8), contains `feat/agent-visibility-map`. Planning
  within the record, and one answer to whether a reviewer is still waiting.

Where the stage table and the delivery differ:

- Stage 1 also had to change `scripts/gates/boundaries.mjs`, which scanned only
  what an app import reached, so a brand new package had no edge to check.
- Stage 4 shipped the node last-briefing route and its MCP tool, which the
  table puts in stage 5c; 5c shipped the view that reads them.
- Stage 6 moved the map to its own top-level directory instead of editing
  `engine/work-scope/map.ts`, and added a migration the row does not mention.
- Stage 9 is wider than its row: the words that needed correcting were in
  ADR-001, all four routing tables, `docs/architecture/data-model.md` and a new
  `.claude/rules/agent-visibility.md`, not only `CONTEXT.md` and the roadmap.

## Decisions taken during delivery

Each of these came from a scenario pass or a gate, changed what was built, and
would otherwise live only in a chat transcript.

- **A related repository gets its own derived origin.** A ticket trigger never
  uses `event_repository_and_related` (that policy is legal only on pull
  request triggers), so nothing derived the neighbour at all. Recording it as
  `trigger_policy` would send a person reading the Decision Trail to a trigger
  that says nothing about relationships, so the work scope contract gains one
  new origin with its own rank, and the CHECK constraint on `work_scope_entries`
  gets its migration. `eventRelatedKeys` is filled as well, which fixes the
  pull request path.
- **A neighbour nobody chose attaches read only.** Workspace access defaults to
  write, so taking a related repository automatically would widen what a run may
  modify. Write comes only from the plan's `writeRepositories` or from a person.
- **The briefings list carries a run-level state** (`available`, `expired`,
  `replay_gone`, `predates_capture`) beside its items, because after retention a
  run has no attempts and no briefings, and an empty list would read to a person
  as "the system lost it".
- **Briefings are read with the replay's audience, not the run detail's.** The
  two run surfaces scope differently today and `agent_briefings` carries no
  tenant column, so the read model resolves the organization from the run and
  refuses with a named reason when it cannot, rather than answering 404 (which
  reads as "no briefings") or reading openly. Giving briefings their own tenant
  column is the durable fix and is not in this plan.
- **The MCP page budget is measured on the result, not on the page.** The
  envelope goes out twice (a text block and `structuredContent`) and the cap
  measures `{data, meta}`, so the package's maximum page was unservable and a
  48 KB page crossed the wire at about 98 KB. The tool derives its own default
  and maximum from a measured allowance and refuses above it.
- **Lists page on a position that proves it is still valid.** The first
  version of this line said the cursor would be on an append-only key, because
  a positional cursor over a live run serves one item twice and skips another
  with nothing red anywhere. It shipped as a position, and the review caught
  the gap between the two. Rather than move the rule to fit the code, the
  cursor now carries the length of the list it was minted against and a list
  that grew or shrank refuses it by name, which is the property the keyed
  cursor was for. The rule in `.claude/rules/agent-visibility.md` says that.
- **Rounds are an opt-in on `work_scope.get`**, so a client that has called it
  for months keeps today's answer inline.
- **`map_shown` gets its writer.** A briefing lives thirty days and the work
  scope record outlives it, so after retention the trail line is the only
  account of what the map said.
- **The repository map lives in its own directory**, imported by the engine and
  by the sandbox composer, because the obvious home created an
  `engine <-> sandbox` cycle and a type-only import would have hidden it rather
  than removed it.

### Recorded late, after the code review found them unrecorded

The three below were decided while the work ran and were not written here at
the time. A decision nobody can find is the failure mode this section exists to
prevent, so they are recorded now with what they cost, late rather than never.

- **A send made while capture is off writes a marker, where stage 3b's
  definition of done said it writes nothing.** The reason is the one the
  changelog states: a run that recorded nothing and a run nobody kept anything
  for are different facts, and without a row per send the reader cannot tell
  them apart. The cost is a row per send on a deployment that has capture
  switched off, which is the price of that distinction.
- **Stage 8 changed when a run starts, which no plan line asked for.** Its file
  scope named the gate, the prompt and the review ledger. It also changed
  `services/dispatch/trigger-events.ts` at all three echo filters, because the
  same identity rule that decided "is this comment ours" at the gate decided it
  at the trigger, and a reviewer using GitHub's Quote reply on one of our notes
  was starting no run at all: no run, no comment, no failure, nothing to look
  at. The advisor directed it deliberately and it is in the changelog; it
  belongs here because it widened production trigger behaviour.
- **The prompt preview names four more things a run composes than stage 5c
  scoped**, and the panel stopped claiming its list is complete. The list had
  already fallen behind once, when stage 6 added the repository map and nothing
  came back to it.

### Still open, and it is the owner's

- **Briefing retention outlives the replay, where this plan first said it never
  would.** The first version of the plan stated the invariant "never kept
  longer than the replay that reaches them". What shipped is a floor of thirty
  days from each send (`GREATEST(replay_expires_at, captured_at + 30 days)`),
  so a send made in a long-parked run outlives the replay that no longer
  reaches it. The amendment describing that behaviour was written by the person
  who directed the work, which is the code writing the specification. It is
  recorded here as an open question rather than a settled decision: briefings
  carry ticket bodies, `AGENTS.md` and repository memory, so how long they live
  is the owner's call, and the alternative (expire with the replay and say so)
  is one condition in the sweep.
- **Which stored harness profiles set `includeWorkflowData` off** was listed
  out of scope as "stage 2 reports which profiles set it and the owner
  decides". No such report was ever produced, so the decision is blocked on a
  fact nobody has gathered. It is a read over production data and it is in
  `lanes/prod-test-av.md`.
