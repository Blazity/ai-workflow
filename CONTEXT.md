Status: current
Last-verified: 2026-09-18

# AI Workflow

AI Workflow automates work on issue-tracker tasks by preparing source context,
running a coding agent, and publishing reviewable changes back to the user's VCS
provider.

## Language

**Repository**:
A provider-backed primary source Git repository that AI Workflow can select for
a run. A GitHub repository is a repository directly; a GitLab project contributes
its primary source repository.
_Avoid_: Codebase, repo/project

**Accessible Repository**:
A repository visible to the configured VCS provider credentials. One deployment
has many accessible repositories.
_Avoid_: Available repo, token-visible project

**Repository Catalog**:
The admin-managed list of repositories this deployment knows, each with an
enabled switch and a versioned profile (description, rules, relationships,
script groups). It is what an operator edits on the Repositories page and, once
activated, what decides which repositories the agent may touch.
_Avoid_: Repo list, repo registry, repository directory

**Repository Directory**:
Provider-side discovery: what the VCS credentials can see, read at runtime by
`apps/worker/src/engine/repository-discovery/`. It reports what exists; the
repository catalog decides what is allowed.
_Avoid_: Repository catalog, repo index

**Selected Repository**:
An accessible repository chosen for a specific workflow run. One workflow run
has one or more selected repositories.
_Avoid_: Active repo, target repo

**Work Scope**:
The per-subject record of which repositories a piece of work touches and why.
Its entries are repositories with a state (selected, excluded, unavailable), a
reason when unavailable, an origin, a short rationale, and who decided, when,
in which run. Only finite work carries one: a ticket, a pull request, or a
webhook delivery whose endpoint resolves a subject id, never a schedule.
An origin of `related_repository` means the catalog relates that repository to
one this work names: the run took it without asking, it is checked out read
only (write comes from a plan or a person, never from a catalog edge), and it
is the one origin re-derived on the next run, so deleting the relationship
removes the entry with a trail line saying why.
_Avoid_: Repository scope (that is the definition pin), repo selection

**Trigger Repository Policy**:
The optional policy on a trigger node of a workflow definition: a candidate set
(the whole enabled catalog, the event repository and its related repositories,
or an explicit list of catalog keys) and an expansion rule (attach, ask once,
never). An absent policy means the defaults for that trigger kind, with the
definition's repository pin, where one names repositories, as the candidate set.
_Avoid_: Repository scope, trigger scope

**Decision Trail**:
The append-only history behind a work scope. The entries are its fold; the
trail is why each entry looks the way it does.
_Avoid_: Audit log, scope history

**Clarification Round**:
One repository question and everything that happened to it: what was asked,
every distinct delivery of an answer with how it was read and the note posted
back, and the trail events that followed. A question a retried attempt asks
again joins its round instead of opening a new one. The Jira path recomposes
the same answer from the ticket's comments on every poll tick, so identical
arrivals are one delivery with a count and the first and last time, not two
hundred rows.
_Avoid_: Clarification request (that is the stored question alone), thread

**Repository Map**:
The one description of repositories every repository-working send renders into
the agent's context: the workspace and what may be changed in it, the
repositories one relationship away that may be requested, the ones already
decided and marked "do not request" with their reason, and one line each for
the rest of the catalog. Descriptions are the operator's catalog profile, with
the provider's listing text only as a labelled fallback. Deterministic, grouped
by how a repository may be used and then ordered by key, and bounded by
construction so it can never push our own rules past the prompt's section cap.
The same build produces the structured repository context a briefing records.
_Avoid_: Repository list, catalog dump, Selected Repositories (the map's first
group, not a section of its own)

**Changed Repository**:
A selected repository where the agent produced changes that should be published
for review.
_Avoid_: Dirty repo, modified repo

**Workflow-Owned Branch**:
A branch that AI Workflow created or durably recorded for a specific ticket and
repository. One ticket can have many Workflow-Owned Branches, but at most one
per repository. PR/MR metadata can be attached to the branch record after review
is opened.
_Avoid_: Inferring ownership from branch name alone without an AI Workflow record

**Sandbox**:
An isolated execution environment where AI Workflow runs the coding agent.
_Avoid_: Workspace, checkout

**Run Workspace**:
The per-run filesystem prepared inside a sandbox for the agent. One Run
Workspace contains one or more selected repositories and AI Workflow artifacts.
_Avoid_: Workspace without a qualifier, sandbox root

**Workflow Definition**:
A versioned executable graph of blocks and control-flow connections. A deployed
Workflow Definition is immutable; changing its behavior creates another version.
_Avoid_: Workflow layout, run, mutable deployed workflow

**Workflow Run**:
One execution of an exact Workflow Definition version, started by one trigger.
Its recorded history remains tied to that version.
_Avoid_: Workflow Definition, current draft

**Block**:
One authored step in a Workflow Definition. A block has a visible semantic
contract, configured inputs, typed output, and control-flow connections.
_Avoid_: Node when discussing product behavior, interchangeable agent preset

**Data Reference**:
A canonical path to Runtime Data from the run entry, an upstream Block, or
Workflow Run metadata. Authoring surfaces present Data References through
context-valid pickers and readable chips rather than exposing raw paths.
_Avoid_: Magic global prompt variable, control-flow connection

**Prompt Slot**:
A named value required by reusable prompt content and supplied by the Block that
uses it. Prompt Slots are required by default but can be explicitly optional or
have a default. The editor exposes them as explicit bindings and validates them
before the prompt can be executed.
_Avoid_: Silently substituting missing prompt data with empty text

**Harness Profile**:
A named, versioned description of the complete reusable agent-harness
environment. It is separate from a block's semantic contract and role prompt.
_Avoid_: Model preset, agent block type

**Runtime Instruction**:
A directive that influences agent behavior and comes from a Harness Profile,
repository-native instruction file, or block prompt. Ticket content and upstream
outputs are Runtime Data, not Runtime Instructions.
_Avoid_: Treating injected ticket or repository data as an instruction layer

**Domain Outcome**:
A typed, expected result produced when a block executes correctly, including a
negative review or failed check. A Domain Outcome can be evaluated by a Branch.
_Avoid_: Execution error, infrastructure failure

**Execution Failure**:
An unexpected sandbox, provider, parser, schema, or workflow-engine failure that
terminates the Workflow Run at the top level. It is not a block output or an
authored control-flow path.
_Avoid_: Failed review, failed check, negative outcome

**Block Attempt**:
One execution of a block. Retries and loop iterations create separate Block
Attempts while the block retains one summary status for the Workflow Run.
_Avoid_: Treating every retry as a separate block

**Transform**:
A block that reshapes explicitly bound JSON data through a finite set of
product-defined operations. It does not execute user-authored code.
_Avoid_: Script block, hidden data behavior on a control-flow connection

**Visual Replay**:
A read-only presentation of recorded Workflow Run observations that highlights
executed blocks, selected branches, timing, and sanitized data. It never reruns a
block or repeats a side effect.
_Avoid_: Retry, re-execution, event-sourced reconstruction

**Agent Briefing**:
Everything one model send gave an agent, recorded as it was sent: the prompt
section by section with the origin of every part, the repositories the send
described, and the harness extras (model, output schema, delivered skills). One
per send, not one per Block Attempt, because a planning block restarts inside
one attempt and only the later passes carry the notes that explain the earlier
ones. Identified by run, node, attempt, activation scope and a sequence number
that counts every send of that Block Attempt in the order they happened. It is
recorded from inside the step that sends and redacted once, there, so the
dashboard and MCP hand back the same bytes. It is kept thirty days from its
own send, and longer where the run's replay outlasts that.
`ENABLE_AGENT_BRIEFINGS` switches recording off for the next run, never for one
in flight, and a send made while it was off is marked as not recorded rather
than read as never sent.
_Avoid_: Prompt log, agent transcript (what the agent then did inside the
sandbox is not recorded)

**Briefing Section**:
One named region of a prompt as the compiler builds it: `profile`,
`repository`, `memory`, `block` and `runtime`, plus `discovery` for the
discovery prompt and `system` for an in-process model call. A section is the
unit a harness profile switch turns on or off.
_Avoid_: Prompt block, chunk

**Prompt Part**:
The smallest named piece of a Briefing Section, in the order it was sent. The
parts of a section concatenate to its text, so every byte a model receives
belongs to exactly one part and can be attributed. A part carries an origin: an
open slug such as `platform` for our own rule text, and `ticket`,
`clarification`, `research_note`, `pull_request`, `repository_catalog`,
`block_prompt` or `bound_data` for the run's own data. A part may be withheld
(a platform rule this prompt holds back on purpose, kept at zero bytes with the
reason, so a reader sees it was left out deliberately rather than forgotten) or
cut before sending. Cut before sending and truncated for storage are different
fields: the first changed what the agent got, the second only what we kept.
_Avoid_: Prompt fragment, snippet

**Validation Issue**:
An authoring error that prevents a Workflow Definition draft from being
deployed. A Validation Issue does not necessarily prevent an incomplete draft
from being saved. A block-level Validation Issue identifies its Block; a
workflow-level Validation Issue applies to the definition as a whole.
_Avoid_: Warning, runtime Execution Failure

**Retired Variable**:
An environment variable the worker no longer accepts. Its behavior either
moved into the settings store or to another explicit owner. The worker neither
parses nor imports it and refuses to boot if it is present, naming every
offender and the SETUP.md removal section. Follow that section's replacement,
remove the variable, and redeploy. A key marked `requiresRedeploy` is not retired: its
environment value remains the deployment's answer and a stored row is ignored.
_Avoid_: Migrated variable, legacy fallback, deprecated setting

**GitLab Project**:
A GitLab collaboration container that owns settings and features around one
primary source repository.
_Avoid_: Treating GitLab project as synonymous with every Git-backed object under it

**Repository Relationship**:
A typed connection from one repository catalog profile to another. Its fixed
kind explains how the repositories relate in prompts and discovery; an optional
note adds operator context without becoming an instruction line.
_Avoid_: Free-form relationship label

**Integration**:
A package under `integrations/<id>` that connects the product to one third
party, such as an issue tracker, a chat or a version control host. Its manifest
declares what it needs to connect and what it unlocks (capabilities, blocks,
pages, health checks); its runtime receives only what core hands it: its
connection, an HTTP client, a logger, and while a block runs, the run, the
capabilities the block declared and a model. It is compiled into every build;
a deployment decides whether it is connected and enabled.
_Avoid_: Plugin in code and docs (fine in conversation), adapter, provider when the package is meant

**Integration Capability**:
A seam in core that an integration can fill: `issue_tracker`, `vcs`,
`messaging`, `memory`, `agent_tracing`, and the reserved `agent_tools`. Each
has a port the provider implements and a cardinality: one active provider per
deployment, or many at once. It is not a Harness Capability, which is what a
model harness advertises in the model catalog (reasoning efforts, service
tiers).
_Avoid_: Feature, harness capability

**Connection Source**:
Where an integration's connection values come from: the environment variables
its fields declare, or values an admin stored from the dashboard. There is
exactly one per integration, chosen explicitly, and values never mix across the
two. With nothing stored, a complete environment is the source; a partial one
makes the integration Failing.
_Avoid_: Override, fallback

**Integration Block**:
A block that belongs to an integration. Its type is `<integration id>_<name>`,
the palette groups it under the integration, it is available only while the
integration is connected and enabled, and it runs as exactly one step. Waiting
for a person, looping and sleeping stay in core blocks.
_Avoid_: Provider block, plugin block

**Generic Integration Step**:
The one core step that runs the executor of every Integration Block. Integration
code carries no step directive, so moving or renaming an integration never
strands a run.
_Avoid_: Integration step, which reads as a step inside the integration

**Wiki Repository**:
An auxiliary Git repository attached to a provider object for documentation.
Wiki repositories are not repositories for AI Workflow unless the product
explicitly supports wiki editing.
_Avoid_: Including wiki repositories in normal repository selection

## Example Dialogue

Developer: "Should this run select the GitLab project or the repository?"

Domain expert: "Select the repository. For GitLab, that means the project's
primary source repository, not the wiki repository or every Git-backed feature
inside the project."

Developer: "Do we create PRs for all selected repositories?"

Domain expert: "No. Create PRs only for changed repositories. A selected
repository might be present only so the agent can read it."

Developer: "Should a repository with a matching branch be selected on a rerun?"

Domain expert: "Only when AI Workflow has a Workflow-Owned Branch record for
that ticket and repository. A branch name by itself does not prove ownership."

Developer: "Is the sandbox the same thing as the workspace?"

Domain expert: "No. The sandbox is the isolated environment. The Run Workspace
is the filesystem AI Workflow prepares inside it for one run."
