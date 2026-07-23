# AIW-147 Multi-Repository Research and Discovery Design

**Date:** 2026-07-23
**Status:** Updated against `origin/main` at `2136f0c`, pending re-review
**Ticket:** AIW-147

## Goal

Allow a ticket run to discover, read, and modify work spanning multiple
repositories without cloning every accessible repository or asking the user to
choose a repository in the common case.

The research/planning agent must inspect real code before producing a plan. It
may expand its workspace when the first repository set exposes a dependency on
another repository. Implementation may modify more than one repository and the
existing publication flow must open one pull request or merge request per
changed repository.

## Constraints

- A deployment exposes no more than 200 accessible repositories.
- Discovery and every later repository operation remain constrained by
  `AGENT_ALLOWED_REPOS`. An empty allowlist retains the existing documented
  unrestricted behavior.
- The initial discovery result contains at most 3 repositories.
- Research may perform at most 2 repository-expansion rounds.
- Each expansion round adds at most 3 repositories.
- A research workspace contains at most 8 repositories.
- "Which repository?" remains the fallback for low confidence, invalid model
  output, an exhausted expansion limit, or a missing repository.
- Provider credentials remain server-side. The agent never receives clone or
  push credentials.
- Existing mixed GitHub/GitLab support remains supported.
- Existing trusted multi-repository publication remains the basis for push and
  PR/MR creation.

## Current-State Findings on Latest Main

The current system already has most multi-repository publication primitives:

- `SelectedRepository[]` flows through the worker.
- `SandboxManager.provisionMultiRepo()` clones multiple repositories.
- The workspace manifest records every checkout.
- Finalization detects changed repositories and opens one PR/MR per changed
  repository.
- Workflow-owned branches are provider-scoped and persisted per
  ticket/repository pair.
- Newly authored V2 workflows place `prepare_workspace` before
  `planning_agent`.
- V2 graph validation already classifies `planning_agent` as
  `shared_read` and prevents unsafe concurrent reader/writer scheduling.
- A prepared code workspace installs every harness profile required by the
  graph, and clarification restore can rebuild those runtimes.
- Repository-instruction prompt composition already tries to read instructions
  for planning from `ctx.sandboxId`.

The runtime still contradicts those newer graph-level contracts:

- `planning_agent` always executes in a repository-free scratch sandbox, even
  after V2 `prepare_workspace` created a shared code workspace.
- The instruction loader may read repository instructions from the shared
  workspace, but the planning CLI itself cannot inspect repository files.
- V1 workflows still reach planning before any explicit workspace block.
- Repository selection trusts only deterministic signals. When multiple
  repositories are accessible and none is named exactly, it asks the user.
- `prepare_workspace` creates or resets remote workflow branches before
  research, so the existing provisioning path is not safe for read-only
  discovery.
- The manifest has one implicit write-oriented repository shape; it cannot
  distinguish research-only checkouts from repositories authorized for
  changes.

AIW-147 therefore extends discovery and workspace lifecycle rather than
replacing the existing multi-repository publication system. It also closes the
specific V2 runtime mismatch instead of adding a second planning mechanism.

## Latest-Main Integration Decisions

- Keep `prepare_workspace` before planning in V2. Repository discovery becomes
  part of workspace preparation when deterministic selection is insufficient.
- Make planning use the prepared shared workspace. Do not leave the V2
  `shared_read` classification as validation-only metadata.
- Preserve V1 compatibility by having `planning_agent` implicitly call the same
  idempotent workspace preparation path when no workspace exists.
- Keep harness-profile resolution as the single source of the planning
  provider, model, CLI version, skills, authentication, runtime limits, and
  telemetry. AIW-147 must not create a parallel direct-API model path.
- Split read checkout from write promotion. Existing branch preparation moves
  out of initial workspace provisioning and runs only for the research-approved
  write set.
- Extend the existing trusted manifest rather than introducing a second
  unrelated research manifest.
- Treat scratch-to-code conversion as an explicit ownership transfer:
  `agentSandboxIds` must stop identifying the sandbox once it becomes
  `ctx.sandboxId`, otherwise clarification cleanup could detach the live code
  workspace.

The resulting control flow is:

```text
ticket/PR trigger
  -> list and normalize accessible repositories
  -> deterministic scope?
       yes: provision read workspace
       no:  harness-based metadata discovery -> promote sandbox to read workspace
  -> planning in shared read workspace
       -> request bounded repository expansion -> attach -> repeat planning
       -> clarification -> snapshot/restore expanded workspace
       -> complete -> validate read/write scope
  -> promote only write repositories
  -> implementation/review/checks
  -> verify every read repo stayed unchanged
  -> publish one PR/MR per changed write repo
```

Primary implementation seams on current main:

- `pre-sandbox/steps/repo-selection.ts`: deterministic selection, bounded
  catalog construction, and clarification inputs;
- `workflows/blocks/prepare-workspace.ts`: discovery fallback, read-only
  provisioning, scratch ownership transfer, and idempotent state return;
- `sandbox/manager.ts` and `sandbox/repo-workspace.ts`: attach/hydrate,
  manifest V2, baseline verification, and write promotion support;
- `workflows/agent.ts`: run planning in `ctx.sandboxId`, process
  `repositories_needed`, and preserve expansion state across clarification;
- `workflows/repository-prs.ts` plus provider adapters: ownership-safe delayed
  branch creation;
- approval schema/store/dispatch: persist and revalidate approved repository
  scope;
- trusted finalization/publication: reject read-repository mutations before the
  first push.

## Chosen Architecture

### 1. Deterministic repository resolution

Before model-based discovery, the worker collects the complete accessible
repository catalog and force-includes repositories identified by authoritative
signals:

- a workflow-owned branch for the ticket;
- the repository carried by a PR trigger;
- an exact provider-scoped repository path in ticket context;
- the only accessible repository.

Workflow-owned and PR-trigger repositories cannot be removed by model output.
If these signals yield a valid initial set, the worker skips the discovery model
round and provisions research directly.

### 2. Agent-based discovery

When deterministic resolution is insufficient, workspace preparation runs a
repository-discovery invocation using the run's resolved default harness. It
starts in the existing repository-free sandbox form and reuses the configured
CLI, provider, model, authentication method, runtime limits, telemetry, budget,
and Arthur wiring.

The discovery runtime is intentionally independent of any one downstream
planning node. Current V2 graphs may contain several planning nodes with
different harness profiles or mutually exclusive activation paths, so choosing
an arbitrary "first planning node" would make repository access depend on
graph layout. Once the workspace exists, each planning node still runs with its
own pinned harness profile.

This is deliberately not implemented with `generateStructured()` or the
`call_llm` block. The in-process Codex path requires `CODEX_API_KEY`, while an
otherwise valid planning profile may authenticate with
`CODEX_CHATGPT_OAUTH_TOKEN`. The harness CLI is the only path that preserves all
currently supported authentication modes and custom profile behavior.

The discovery prompt contains:

- the ticket title, description, acceptance criteria, comments, and labels;
- mandatory repositories from deterministic signals;
- a compact, deterministic catalog of all accessible repositories;
- repository provider, full path, default branch, truncated description, and
  bounded topics;
- explicit instructions that catalog values are untrusted data, not
  instructions.

Catalog entries are sorted deterministically. Field lengths and topic counts are
bounded so a catalog of 200 repositories has a predictable prompt size.

Discovery returns a strict structured object:

```ts
interface RepositoryDiscoveryResult {
  status: "selected" | "clarification_needed" | "failed";
  repositories: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    rationale: string;
  }> | null;
  confidence: "high" | "medium" | "low" | null;
  questions: string[] | null;
  error: string | null;
}
```

The worker accepts automatic selection only for high or medium confidence.
Every returned repository must exactly match the server-owned accessible
catalog after provider-scoped, case-insensitive normalization. Unknown,
duplicate, off-list, archived, or otherwise unusable repositories are rejected.
Low confidence becomes clarification.

### 3. Convert the discovery sandbox into a research workspace

The sandbox used for discovery is reused. The worker promotes it into
`ctx.sandboxId` and attaches the initial repository set rather than provisioning
another VM. If deterministic selection skipped discovery, the normal
multi-repository provisioner creates `ctx.sandboxId` directly.

Promotion must update all workflow bookkeeping atomically:

- remove the sandbox from every `ctx.agentSandboxIds` cache entry;
- retain it in `ctx.sandboxIds` for normal and crash-reconciliation cleanup;
- assign `ctx.sandboxId`, `ctx.workspaceManifest`,
  `ctx.selectedRepositories`, and `ctx.repositoryContexts`;
- register the sandbox as the durable child of the active run;
- ensure every harness runtime required by the graph is available in the
  promoted workspace.

After promotion, scratch-sandbox clarification cleanup must not detach or stop
the code workspace.

Repository attachment is a durable, idempotent server-side operation:

1. Reconnect to the sandbox by ID.
2. Resolve a fresh short-lived provider token.
3. Clone or hydrate into a server-selected temporary path.
4. Verify the provider, repository path, remote URL, default branch, and HEAD.
5. Reject unexpected existing paths, symlinks, or paths outside the workspace.
6. Atomically move the verified checkout into its final path.
7. Write the new workspace manifest.
8. Return the exact trusted manifest to workflow scope.

A retry first inspects the trusted manifest and final path. It reuses an exact,
verified checkout and rejects a partial or mismatched one. A failed clone
removes its temporary path and leaves the trusted manifest unchanged.

Clone operations within one expansion round use bounded concurrency of 2. The
primary checkout may remain the sandbox root to preserve current path and
publication assumptions; later repositories use the existing
`/vercel/sandbox/repos/<provider>__<slug>` layout.

### 4. Research workspace manifest

The manifest gains an explicit access mode and research baseline:

```ts
interface WorkspaceRepositoryV2 {
  provider: "github" | "gitlab";
  repoPath: string;
  localPath: string;
  defaultBranch: string;
  access: "read" | "write";
  researchBaseSha: string;
  selectedRationale: string;
  branchName?: string;
  expectedRemoteSha?: string;
  preAgentSha?: string;
  workflowOwnedBranch?: WorkflowOwnedBranch;
}
```

Repositories start with `access: "read"` unless they already carry a
workflow-owned branch that the run is explicitly remediating.

This is a versioned extension of `WorkspaceManifest`, not a second file.
Parsing keeps explicit V1 compatibility for clarification snapshots and runs
started before deployment, while every newly provisioned workspace writes the
new version. All existing manifest consumers must either understand access
mode or reject the newer manifest; none may silently treat `read` as writable.

The manifest stored in workflow context is authoritative. The sandbox copy must
match it field-for-field before clarification snapshots, repository expansion,
write promotion, implementation, and publication.

### 5. Iterative planning

After initial attachment, the normal `planning_agent` invocation runs against
`ctx.sandboxId`. In V2 this realizes the existing `shared_read` contract; in V1
the planning block first invokes idempotent workspace preparation. The
repository-free `ensurePlanningAgentSandboxForBlock()` path remains only for
metadata discovery before a code workspace exists.

The existing research schema is versioned to support:

```ts
type ResearchStatus =
  | "completed"
  | "repositories_needed"
  | "clarification_needed"
  | "failed";
```

For `repositories_needed`, output contains 1 to 3 exact provider/repository
identities and a reason for each. The worker:

1. validates each request against a fresh server-owned catalog and allowlist;
2. removes already attached repositories;
3. enforces per-round, round-count, and total-workspace limits;
4. attaches the validated repositories to the same sandbox;
5. reruns planning with the expanded manifest plus the previous research
   result and expansion rationale.

No correctness assumption is made about provider session memory surviving
between harness invocations. Reuse is an optimization; the prompt and trusted
workflow state are sufficient to resume deterministically.

When the round or workspace limit would be exceeded, the workflow asks a
targeted clarification instead of silently dropping repositories.

For `completed`, output contains:

- the implementation plan;
- all repositories used as read context;
- the subset that requires writes;
- a short per-write-repository rationale;
- concrete file or directory evidence when known.

The write set must be a subset of attached repositories. The mandatory
PR-trigger repository remains in scope. A completed result with an empty write
set is rejected for a code-changing ticket.

### 6. Promote write repositories after research

Research never creates new remote branches merely to read code.

Accordingly, `prepareSelectedRepositoryBranches()` is removed from the initial
`ensureWorkspace()` path. Initial clones check out the trusted default-branch
SHA in detached or explicitly read-only form. Branch creation becomes part of a
new promotion step after successful research.

Before promotion, the worker verifies:

- every attached worktree is clean;
- every checkout still matches its trusted research baseline;
- every write repository is still accessible and allowed;
- the requested write set is a subset of the trusted manifest.

For each write repository, the worker then:

1. checks for an existing workflow-owned branch record;
2. if a remote branch with the generated name exists without matching workflow
   ownership, refuses to overwrite it;
3. creates or reuses the workflow-owned branch;
4. fetches and checks out that exact branch in the research sandbox;
5. records `branchName`, `expectedRemoteSha`, and `preAgentSha`;
6. changes manifest access to `write`.

The current provider adapters force-reset an existing same-name branch. That
behavior must not be used unless the database proves the branch belongs to this
ticket and repository.

The promotion step first consults the workflow-owned-branch ledger. For a
foreign same-name remote branch it fails before calling either adapter's
destructive existing-branch path. A separately tested adapter operation may
create a missing branch or reset an exactly owned branch; ownership checking
must remain outside and before the provider mutation.

### 7. Implementation and publication

Implementation runs once in the promoted workspace and sees all read and write
repositories.

Before the first remote mutation, finalization verifies every manifest entry:

- a read repository has no dirty files and no commits beyond its research
  baseline;
- a write repository has complete trusted branch baselines;
- the sandbox manifest still matches the workflow-owned trusted manifest;
- all write repositories remain allowlisted.

Any mutation in a read-only repository fails the run before any repository is
pushed. The existing all-repository preflight, exact leases, changed-repository
detection, and one-PR-per-changed-repository flow remain in place for write
repositories.

Declared write repositories that remain unchanged do not produce empty PRs.

The V2 interpreter may replay durable steps, so attachment and promotion return
complete state rather than depending only on in-memory mutation. Re-execution
must reconcile the trusted manifest, branch ledger, remote head, and local
checkout before deciding that an operation already succeeded.

## Plan-Approval Runs

Plan approval ends the planning run and starts implementation later as a fresh
run. A live sandbox is therefore not the contract between the two runs.

The latest approval flow already pins the workflow definition and version, but
its payload persists only plan markdown and assumptions. The approval record
and approved-run payload additionally persist:

```ts
interface ApprovedRepositoryScope {
  repositories: Array<{
    provider: "github" | "gitlab";
    repoPath: string;
    defaultBranch: string;
    access: "read" | "write";
    researchBaseSha: string;
    rationale: string;
  }>;
}
```

The approved implementation run re-lists accessible repositories, verifies the
allowlist, and recreates the exact scope. If any repository is missing,
inaccessible, or its default-branch SHA differs from the approved research
baseline, the approval is stale. The implementation does not silently run the
approved plan against different code; the ticket must be replanned and approved
again.

The scope is bound to the same pinned workflow-definition version as the plan.
Dispatch must copy both together into `trigger_plan_approved`; a legacy approval
without scope uses the existing compatibility path and performs ordinary
selection rather than inventing trusted baselines.

## Clarification and Snapshot Durability

Clarification before repository attachment suspends without a workspace
snapshot.

Clarification after attachment verifies the trusted manifest, scrubs
credentials, and snapshots the expanded workspace through the existing
clarification mechanism. Restore must:

- restore every checkout and the current manifest;
- replace sandbox IDs in durable step outputs;
- reinstall current credentials for every agent kind required by planning,
  implementation, review, fix, or workspace-enabled generic blocks;
- refresh PR context for selected repositories;
- continue the current discovery/planning round without resetting expansion
  counters.

Planning providers must be included when computing agent kinds required in a
code workspace and after snapshot restoration.

Current main already includes all definition-required harnesses in prepared
workspaces. AIW-147 preserves that mechanism and adds regression coverage that
the planning harness executes in the restored shared workspace. A promoted
discovery sandbox must be absent from `agentSandboxIds` before snapshot
creation.

## Repository Catalog and Allowlist Corrections

Repository discovery must operate on the same normalized catalog used for
validation and attachment.

The catalog excludes archived or disabled repositories. Repositories without a
usable default branch are marked as empty/uninitialized and selected only when
the ticket explicitly targets repository initialization.

`AGENT_ALLOWED_REPOS` currently accepts exactly one slash. The parser must
accept paths with at least two non-empty segments so nested GitLab namespaces
such as `group/team/repository` work. Provider-scoped validation still prevents
GitHub from accepting impossible nested paths.

If listing any configured provider fails, discovery fails closed rather than
continuing with a silently incomplete catalog.

If the accessible catalog exceeds 200 entries, the worker asks for
clarification or reports an operator configuration error. It never silently
truncates the security and discovery scope.

## Security

- Provider tokens are resolved only inside server-owned steps.
- Auth headers are used only for clone/fetch commands and are not persisted in
  Git remotes, files, agent environment, or session memory.
- Model-selected repository identities never authorize access by themselves.
- Repository paths are normalized and validated before filesystem use.
- Dynamic attachment rejects traversal, symlink redirection, and pre-created
  mismatched paths.
- Repository descriptions, topics, ticket text, and checked-out code are
  untrusted model inputs.
- Write promotion is a separate server-side decision after research and before
  implementation.
- Read-only mutation is a hard pre-publication failure.
- A same-name remote branch without exact database ownership is never reset.

## Failure Handling

- Catalog read failure: fail closed before clone or branch operations.
- Discovery schema failure: one controlled failure; do not stack fallback
  guesses.
- Low confidence: ask which repository to use.
- Unknown or off-list repository request: clarification without exposing
  repositories outside the accessible catalog.
- Clone/fetch failure: remove temporary state, preserve the prior manifest, and
  surface the provider/repository that failed.
- Default branch moved during active research: fail promotion as stale and
  rerun planning.
- Expansion limit reached: clarification naming the missing dependency.
- Research dirty worktree: fail before branch creation.
- Foreign same-name branch: fail without modifying the branch.
- Read-only repository changed: fail before any push.
- Partial PR creation: rely on existing find-before-create reconciliation so a
  retry reuses already-created PRs/MRs.
- Sandbox timeout: surface a resumable workflow failure; clarification
  snapshots remain the supported long-wait boundary.

## Performance

- Deterministic signals skip model discovery when sufficient.
- One sandbox is reused for discovery, research expansion, planning, and
  implementation within one continuous run.
- Legacy agent CLIs are installed once per continuous run. Versioned harness
  profiles may rebuild their invocation boundary as required by the current
  runtime; AIW-147 does not add an extra rebuild beyond those existing
  guarantees.
- Repository catalogs are compact and bounded.
- Only selected repositories are cloned.
- Expansion clones use concurrency 2.
- Maximum checkout count is 8.
- Provider repository listings run in parallel, but an incomplete provider
  result fails closed.
- No repository-content indexing or clone-all cache is introduced in AIW-147.
  Telemetry from discovery confidence and expansion requests should determine
  whether a cached package/README index is justified later.

## Observability

Record structured telemetry for:

- catalog size and provider counts;
- deterministic versus model selection;
- discovery confidence;
- selected repositories and rationales;
- discovery and planning model usage;
- expansion round count and requested/accepted repositories;
- clone duration and failure per repository;
- research workspace size;
- final read/write scope;
- stale approval or baseline failures;
- clarification fallback reason;
- PR/MR count per completed run.

Repository paths are operational identifiers already visible to the configured
deployment. Tokens, auth headers, and repository file contents are never logged.

## Testing Strategy

### Unit tests

- Deterministic selection force-includes exact, workflow-owned, and PR-trigger
  repositories.
- Discovery catalog normalization, ordering, truncation bounds, and prompt
  escaping.
- Strict discovery output validation for confidence, duplicates, unknown repos,
  off-list repos, provider collisions, and more than 3 selections.
- Expansion validation for duplicate requests, round limits, per-round limits,
  and the 8-repository total.
- Nested GitLab allowlist paths.
- Read/write scope validation.
- Foreign branch collision refusal.
- Plan-approval scope serialization and stale-baseline detection.
- Scratch-to-code ownership transfer removes `agentSandboxIds` without losing
  durable cleanup registration.
- Manifest V1 compatibility and V2 fail-closed access parsing.

### Sandbox/workspace tests

- Convert a repository-free sandbox into a research workspace.
- Attach multiple GitHub and GitLab repositories.
- Bounded concurrent attachment.
- Idempotent replay after successful attachment.
- Cleanup after a partial clone.
- Reject pre-created paths, symlinks, traversal, remote mismatch, and HEAD
  mismatch.
- Atomically update and verify the trusted manifest.
- Promote only write repositories and leave read repositories on their default
  branches.
- Restore an expanded workspace from a clarification snapshot.

### Workflow tests

- Planning has repository code available before producing a completed plan.
- The default V2 `prepare -> planning` graph executes planning in the prepared
  shared workspace, matching `workflowWorkspaceAccessOf(planning_agent)`.
- A V1 planning-first graph implicitly prepares the same workspace.
- An ambiguous ticket uses model discovery instead of immediately asking.
- Planning requests another repository and completes on the next round.
- A second expansion works; a third becomes clarification.
- Planning and implementation can use different agent providers in one
  workspace.
- Clarification cleanup never detaches a discovery sandbox after it has been
  promoted to the shared workspace.
- A plan-approval run persists scope, recreates it after approval, and rejects
  changed baselines.
- A PR-trigger run keeps its source repository mandatory while allowing
  additional read context.

### Security and publication tests

- An off-list model request never reaches clone or branch operations.
- Research cannot silently leave worktree changes before promotion.
- Implementation changes to a read repository fail before any push.
- Two changed write repositories produce two PRs/MRs.
- An unchanged write repository produces no empty PR/MR.
- A style/formatting issue observed in repository Y can be researched in Y,
  traced to shared repository X, changed in X, and published only from X.
- A fix spanning X and Y publishes one review link per changed repository.

### Verification commands

The implementation plan will provide exact targeted Vitest commands for each
task, followed by:

```bash
pnpm --filter worker typecheck
pnpm --filter worker test
```

The end-to-end scenario uses controlled fixture repositories first. A live
GitHub/GitLab smoke run is performed only when configured credentials and
dedicated test repositories are available.

## Non-Goals

- Cloning all accessible repositories.
- Building a persistent repository knowledge graph or embedding index.
- Exposing provider tokens or a general-purpose authenticated clone tool to the
  agent.
- Allowing the agent to expand beyond the configured allowlist.
- Publishing changes from repositories that planning did not promote to write
  scope.
- Silently updating an approved plan when repository baselines changed.
