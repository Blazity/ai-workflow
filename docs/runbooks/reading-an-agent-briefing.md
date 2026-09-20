Status: draft
Last-verified: 2026-09-20

# Reading an agent briefing

A run did something you cannot explain, and the question is "what was the agent
actually given". This is where to look, on each surface, and what an empty
answer means. The design and the delivery record are
[the plan](../plans/2026-09-19-agent-visibility.md); the words are
[CONTEXT.md](../../CONTEXT.md).

Status is `draft` because stages 8 and 10 of that plan are open: the surfaces
below exist on their branches and have not been proven on production.

## In the dashboard

- **A run.** Open the run, pick the Block Attempt, then the **Briefing** tab.
  It lists every send that attempt made, in the order they happened, because a
  planning block restarts inside one attempt and the pass that explains the
  failure is usually not the first. Open a send to get the harness context
  (model, output schema digest, pinned skills), the prompt section by section,
  the repositories the send described, and the sources the compiler referenced
  and could not find.
- **Inside a section.** The text is paged and cut into parts, each one
  attributed in the margin: our own rules are origin `platform`, a ticket
  comment is not. A part shown as withheld is a rule this prompt held back on
  purpose, with the reason. A part shown as cut was cut *before sending*, which
  is different from text we truncated to store.
- **A ticket.** The **Repositories** panel, on desktop and on the phone, shows
  the repository record and every repository question as a round: each answer
  as it arrived, how it was read, and what the record did. You can select,
  exclude and undo an entry from there.
- **The flow editor.** A block shows the last real briefing it produced,
  beside the authoring preview. The preview applies the selected profile's
  switches, so a profile with workflow data off previews without run data.

## Through MCP

- `runs.briefing` has seven paged views. `attempts` (the default) lists every
  Block Attempt that sent a prompt or could have, with its briefings in send
  order and a run-level `state`. The rest take a `briefingId` from that list:
  `sections`, `section` (one byte page of one section's text), `parts`,
  `spans`, `repository_context` and `unresolved_sources`.
- `workflows.node_briefing` answers the same question for one block of a
  definition, without first finding a run.
- `work_scope.get` returns the rounds when you pass `rounds: true`. It is an
  opt-in, so a client that has been calling the tool keeps today's answer.
- `limit` is a byte cap, not a count, and it defaults below what a client shows
  inline. Continue a section from the previous page's `nextOffset`, never from
  a number you worked out yourself.

## Over HTTP

`GET /api/v1/runs/{runId}/briefings`, then under
`/api/v1/runs/{runId}/briefings/{briefingId}`: `sections`,
`sections/{index}`, `sections/{index}/parts`, `sections/{index}/spans`,
`repository-context` and `unresolved-sources`. Rounds are
`GET /api/v1/work-scope` plus `rounds/{roundId}/deliveries` and
`rounds/{roundId}/effects`. A block's last briefing is
`GET /api/v1/workflow-definitions/{id}/nodes/{nodeId}/last-briefing`.

A page asked for at a limit both surfaces accept comes back byte for byte the
same on either. What differs is what each will accept and what each gives you
by default: HTTP uses the package's own numbers, and MCP derives smaller ones
from this deployment's `MCP_MAX_RESULT_BYTES`, because an MCP result goes out
twice and would otherwise be replaced by a digest or written to a file. Both
refuse a limit outside their range by name rather than quietly clamping it, so
you always know which page you are holding.

## When there is no briefing

The answer is never a generic message. Whether the prompt went out is decided
first, and only then whether we kept it.

| You are told | It means |
|---|---|
| not sent yet | the attempt is still preparing |
| never sent | it failed or was cancelled before the prompt went out, with the recorded failure |
| not recorded | the prompt went out and no record survives: the run's code predates capture, capture was switched off, or the record was refused |
| expired | it was captured and retention removed it |

The run-level state on the list answers what no single attempt can:
`available`, `expired`, `replay_gone` (the attempt rows went with the replay,
so attempts that never sent cannot even be listed) or `predates_capture`.

## Seeing one without a production run

The dashboard ships a fixture worker that answers from records the real package
built, so the screens and every empty state can be opened in a browser before
any run exists. Two terminals:

```sh
pnpm --filter ai-workflow-dashboard run fixture-worker        # serves :4010
WORKER_BASE_URL=http://127.0.0.1:4010 pnpm --filter ai-workflow-dashboard run dev
```

Then open <http://localhost:3001/ticket/AWP-235>. **Set a `ba_session` cookie
first, to any value at all**, or the page redirects to `/login` and you see
nothing: the fixture worker answers `/api/v1/session` for anything, but the
dashboard still requires the cookie to be there. In a browser console on
`localhost:3001`, `document.cookie = "ba_session=anything"` and reload.

AWP-235 is the only ticket the fixtures carry, and it has three runs. Add one
as `?run=`:

| Run | What it is for |
|---|---|
| `wrun_fx_planning` | a planning attempt that discovers and then plans three passes: the ordinary Briefing tab |
| `wrun_fx_states` | one block per way a briefing can be missing, so every empty state is on one page |
| `wrun_fx_expired` | a run whose replay, and briefings, expired |

So <http://localhost:3001/ticket/AWP-235?run=wrun_fx_planning> is the Briefing
tab with something in it. There is no `/runs/{id}` page; a run is always opened
from its ticket.

`FIXTURE_FAIL=<pattern>` makes matching paths answer 503, which is how the
"could not be loaded" states are looked at, and `FIXTURE_FORBID=1` refuses every
edit. The fixtures themselves are
`apps/dashboard/lib/agent-visibility/test-support/fixtures.ts`.

## Limits worth knowing before you go looking

- **Retention.** A briefing is kept as long as the run's replay, and in any
  case thirty days from its own send: its expiry is the later of the two
  (`GREATEST` in `db/repositories/agent-visibility.ts`), and the sweep deletes
  only once both have passed, re-reading the run row rather than trusting the
  stamp written at capture. So a run parked for a week keeps the briefing of
  its resumed send for thirty days after that send, a week past the replay that
  no longer reaches it. Both windows are module constants
  (`BRIEFING_RETENTION_DAYS`, `REPLAY_RETENTION_DAYS`), fixed at thirty days:
  there is no setting and no environment variable for either.
- **Nothing is re-read at read time.** The catalog, the prompt library and the
  profiles are as that send saw them, not as they are now. That is the point:
  an operator editing a description afterwards must not change what the page
  shows.
- **Not in a briefing.** The harness CLI's own system prompt and tool
  definitions, and what the agent then did inside the sandbox.
- **Who can read one.** Whoever can read the run's logs: `runs.briefing` and
  `workflows.node_briefing` carry the ordinary MCP read scope, the same as
  `runs.logs`. No new scope was created and nobody's grant was widened, but the
  text that scope now returns is far more than it used to be, because a prompt
  carries ticket bodies, `AGENTS.md` and the memory a run was given. If that
  changes who should hold a read token, the lever is not revoking the token: a
  token is a JWT checked against the issuer's keys, nothing reads a stored
  token row, and there is no revoke endpoint. What is checked on every call is
  the client row and the caller's membership
  (`services/mcp/actor-resolution.ts`), so narrowing that client's registered
  scopes caps every token it has already issued, deleting the client row kills
  them all at once, and removing a person's membership kills theirs. All three
  are database edits today; no screen offers them.
- **Switching it off.** `ENABLE_AGENT_BRIEFINGS` on the Settings page. A run
  reads it once at its start, so it stops the next run, not one in flight, and
  the sends of a run that started with it off read as not recorded rather than
  as never sent.
