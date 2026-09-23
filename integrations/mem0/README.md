# Mem0

[Mem0](https://mem0.ai) is a hosted memory engine. Connecting it makes it this
deployment's memory: the facts and lessons runs learn about repositories and
owners, and the notebook an agent keeps for a ticket, are stored in your Mem0
project instead of the built-in store.

## Connecting it

| Field | Variable | Required | What it is |
|---|---|---|---|
| API key | `AIW_MEM0_API_KEY` | yes | A key from the Mem0 dashboard (app.mem0.ai, Settings, API Keys). |

The variable is not `MEM0_API_KEY` on purpose: that is the name Mem0's own
SDKs read, and a deployment that set it for some other tool would otherwise
move every run's memory to Mem0 without anyone pressing Test.

The key decides everything else: Mem0 resolves the organization and project
from it, and Test names both before any run uses them (as Mem0's ids, which the
project's page in the Mem0 dashboard shows). Make a key for one project that
only this deployment writes into.

This integration talks to Mem0's hosted platform (`https://api.mem0.ai`). A
self-hosted Mem0 server speaks a different API; its keys start with `m0sk_`,
and Test says so instead of sending one to the hosted platform.

## What connecting it unlocks

- Memory served by Mem0 for every run, in place of the built-in store.
- The memory screen (`/memory`) and the `memory.list`, `memory.get` and
  `memory.forget` MCP tools list, show and erase what Mem0 holds for this
  deployment.
- The **API access** row on the System health page.

## What an admin should know

- **Connect only when every deployment on this database knows Mem0.** The
  demo and the previews read production's database, so connecting on
  production connects them too. A deployment running a build from before this
  integration shipped reads the connection row of an integration it does not
  have and keeps serving memory from the built-in store, splitting memory
  across two stores. Redeploy them first, or connect while they are idle.
- **Mem0's plan limits the reads.** The free Hobby plan allows 10,000 add
  requests and 1,000 retrieval requests a month (Starter: 50,000 and 5,000;
  Pro: 500,000 and 50,000; mem0.ai/pricing, 2026-09-23). A run on one
  repository with repository memory on reads memory several times per agent
  invocation, so a free plan can be spent within a few hundred runs. What Mem0
  answers once a quota is spent is not documented. A 403 carrying
  `upgrade_required` reads as "refused under the project's plan", memory is
  not used for that step, and the card stays Connected. A bare 403 cannot be
  told from a revoked key: the health row says "Mem0 refused the API key
  (403)", and if someone presses Test the card turns Failing and runs go on
  without memory. Check
  the usage page in the Mem0 dashboard before replacing a key that worked
  yesterday.

- **Connecting copies nothing, disconnecting deletes nothing.** The first runs
  after you connect find Mem0 empty: the repository seed writes again, and a
  ticket already in flight starts without the notebook it had in the built-in
  store (which stays there, untouched). Disable the integration and the
  deployment is back on the built-in store as it was; everything written to
  Mem0 stays there, and reconnecting the same project brings it back.
- **Connect while nothing runs.** A run in flight while you connect may read
  from one store and write to the other.
- **Deployments that share a key share a memory,** one per subject, the same
  way deployments that share a database share the built-in store. One Mem0
  project per deployment keeps them apart.
- **Another application in the same project stays separate.** Everything this
  integration writes carries `app_id: "ai-workflow"`, and every read, listing
  and delete requires it, so a chatbot's memories in the same project never
  reach a prompt, the memory screen or an erasure. Memories written under that
  `app_id` by anything else would be read as ours: do not reuse it.

## How the memory maps onto Mem0

| This product | Mem0 |
|---|---|
| This integration | `app_id` = `ai-workflow` |
| What a memory is about (`ticket:jira:AIW-1`, `repo:github:acme/api`) | `user_id`, exactly |
| Facts, lessons, a ticket's notebook | `agent_id` = `facts`, `lessons`, `notebook/<name>` |
| The run that wrote it, the ticket it belongs to | `metadata.runId`, `metadata.ticketKey` |
| Whether a fact came from a repository's manifest | `metadata.origin` = `derived`, `learned` or `notebook` |

Why these fields: Mem0 files every memory under at least one of `user_id`,
`agent_id`, `app_id` and `run_id`, filters on them exactly, and shows them in
its dashboard, so each of this product's addresses gets one. `run_id` is left
empty on purpose: filed under a run, a memory is invisible to the next run.

**Every write is a Direct Import** (`infer: false`, `immutable: true`): stored
verbatim, one memory per item, and synchronous, so Mem0 answers with the
stored memory rather than an event to poll. Mem0's default add runs its own
extraction model, which costs a model call per write, may reword or drop an
item (a later retraction quoting the original words would then miss it),
applies whatever instructions the Mem0 project carries for other kinds of
memory, and finishes in the background, after the same run has already read
its notebook back. Every item reaching this integration was already distilled
by this product's own model, so a second pass adds nothing.

Mem0 only adds, so this integration reconciles:

- an item already held (the same text exactly) is not stored again;
- a retracted fact is found by its exact words and deleted by id; the count
  reported is the deletes Mem0 confirmed;
- a notebook is replaced: the new text is added, checked against what Mem0
  says it stored, and only then is the previous version deleted by id. An
  unchanged notebook is left alone (Mem0 drops an exact repeat, so "add, then
  delete the old one" would delete the only copy). If Mem0 stores a shortened
  copy, it is taken back out and the previous version kept;
- nothing is ever deleted by filter: Mem0's filter delete runs in the
  background, takes `*` as "everything", and cannot say what it removed.

## How much one subject holds

The same as the built-in store: at most 40 facts and 30 lessons per
repository or owner (`MEMORY_ITEMS_MAX`, shared by every provider). When an
add takes a subject past that, the oldest entries a run learned are deleted by
id and reported as dropped; what a repository's manifest said (`derived`) is
never dropped, and a pure retraction never trims.

## When Mem0 fails

A run never fails because of memory. Each request waits at most 10 seconds and
is sent once. A refused key, a request Mem0 refuses, or a subject key holding
`*` is answered as refused; a rate limit, a 5xx, a timeout or an answer that is
not Mem0's JSON is answered as unavailable, and the run goes on without memory
and logs which. After one request in a step gets no answer at all, the rest of
that step does not ask Mem0 again.

## Erasing a person's data

While Mem0 is connected, the memory screen (or `memory.forget`) erases a
document by deleting each of its memories by id. After Mem0 is disconnected,
the screen shows the built-in store instead, so to erase what Mem0 still
holds, either reconnect it, erase on the memory screen and disconnect again,
or delete in the Mem0 dashboard: filter by `app_id` `ai-workflow` and the
`user_id` of the subject (`ticket:jira:AIW-1`, `repo:github:acme/api`). Mem0's
own delete by filter runs in the background, so check afterwards that the
memories are gone.

## What this integration does not solve

- **Two runs racing on one repository.** Mem0 has no conditional write. If
  run B retracts a fact before run A's add of that same fact lands, the fact
  survives until a later run retracts it again. An identical seed written by
  two runs at once is stored once, because Mem0 drops an exact repeat.
- **A ticket in flight when you connect** starts in Mem0 without the notebook
  it had in the built-in store (which keeps it, untouched). Nothing says so in
  the run itself beyond Mem0 holding nothing for that ticket; connect while no
  run is in flight.

## The memory screen

Documents are listed one per subject and kind (facts, lessons, a notebook),
newest first. The listing reads at most 2,000 memories and says it is partial
when Mem0 holds more. Erasing a document deletes each of its memories by id and
answers "nothing stored" when there was nothing to delete.

## What lives here

| File | What it is |
|---|---|
| `manifest.ts` | Identity, the one connection field, the `memory` capability, the health check. |
| `worker.ts` | The connection test and the health probe. |
| `memory.ts` | The memory port on Mem0: recall, observe, and the memory screen's list, read and erase. |
| `client.ts` | Every request to Mem0, and how each answer or failure is read. |
| `test-fixtures/` | Mem0's answers as its documentation shows them, each with a `.source.txt`. |

## Provider documentation this is written against

API version: Mem0 Platform API v3 for memories (`/v3/memories/`,
`/v3/memories/add/`), v1 for single memories and ping (`/v1/memories/{id}/`,
`/v1/ping/`), as `docs/openapi.json` described them at mem0ai/mem0 commit
`fdfb763d6e5e5509bdb35d4ddc9ca8003f6af009`.

| What | Where | Read on |
|---|---|---|
| Authentication (`Authorization: Token <key>`) | https://docs.mem0.ai/api-reference | 2026-09-23 |
| Validating a key and the project it resolves to | `GET /v1/ping/` in docs/openapi.json; https://docs.mem0.ai/api-reference/organizations-projects; seen live answering 401 to an invented key | 2026-09-23 |
| Add, asynchronous by default | https://docs.mem0.ai/api-reference/memory/add-memories | 2026-09-23 |
| Add with `infer: false`: synchronous, verbatim, exact repeats deduplicated | https://docs.mem0.ai/platform/features/direct-import | 2026-09-23 |
| Get all: paginated envelope, `page_size` at most 200, filters required | https://docs.mem0.ai/api-reference/memory/get-memories | 2026-09-23 |
| Filters: entity fields, `*` as any value, metadata equality | https://docs.mem0.ai/platform/features/v2-memory-filters | 2026-09-23 |
| Entity fields and what a filter leaves unconstrained | https://docs.mem0.ai/platform/features/entity-scoped-memory | 2026-09-23 |
| Delete one memory (synchronous, 404 on a miss) | https://docs.mem0.ai/api-reference/memory/delete-memory | 2026-09-23 |
| Delete by filter (background, accepts `*`), never used | https://docs.mem0.ai/api-reference/memory/delete-memories | 2026-09-23 |
| v3 only adds, memories accumulate | https://docs.mem0.ai/migration/platform-v2-to-v3 | 2026-09-23 |
| Self-hosted server keys (`m0sk_`, `X-API-Key`) | https://docs.mem0.ai/open-source/features/rest-api | 2026-09-23 |
| Rate limits and 5xx | not documented anywhere in Mem0's docs or OpenAPI; read by what HTTP says they mean | 2026-09-23 |
| Plan quotas | https://mem0.ai/pricing (plan table and FAQ); `upgrade_required` on plan-gated 403s in docs/openapi.json | 2026-09-23 |

## Proving it after the merge

The operator's walk-through is in docs/architecture/integrations.md,
"Proving it works". On top of it, for Mem0:

1. Before connecting, a production run's logs show memory served by the
   built-in store (`provider` on the memory log lines).
2. Test on the Connection form names the organization and project ids the
   key belongs to, and they match the project meant.
3. A notebook of about 40 KB and one of about 200 KB each come back byte for
   byte on the next run (`memory_document_hydrated_from_store`), or the save
   says it was refused with both sizes.
4. After Disable, the next run is served by the built-in store again and the
   memory screen shows the built-in documents as they were.

Not verified before the merge, because nothing in Mem0's documentation says:
how large one memory may be (a notebook is stored as one memory, up to 256 KiB;
the write checks what Mem0 says it stored), whether `immutable` has any effect
on a Direct Import, and whether Mem0 ever answers 429 or 5xx with a body.
