# AIW-147 Multi-Repository Research and Discovery Design

**Date:** 2026-07-23
**Status:** Approved in conversation, pending written-spec review
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

## Current-State Findings

The current system already has most multi-repository publication primitives:

- `SelectedRepository[]` flows through the worker.
- `SandboxManager.provisionMultiRepo()` clones multiple repositories.
- The workspace manifest records every checkout.
- Finalization detects changed repositories and opens one PR/MR per changed
  repository.
- Workflow-owned branches are provider-scoped and persisted per
  ticket/repository pair.

The missing behavior is orchestration before planning:

- `planning_agent` uses a repository-free scratch sandbox.
- Repository selection and workspace provisioning happen only when an
  implementation or explicit prepare-workspace block needs a code workspace.
- Repository selection trusts only deterministic signals. When multiple
  repositories are accessible and none is named exactly, it asks the user.

AIW-147 therefore extends discovery and workspace lifecycle rather than
replacing the existing multi-repository publication system.

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

When deterministic resolution is insufficient, the existing planning agent
runs a repository-discovery phase in its repository-free sandbox. This reuses
the configured CLI, provider, model, authentication method, telemetry, budget,
and Arthur wiring.

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

The sandbox used for discovery is reused. The worker attaches the initial
repository set to that running sandbox rather than provisioning another VM or
reinstalling agent CLIs.

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

Clone operations within one expansion round use bounded concurrency of 2.

### 4. Research workspace manifest

The manifest gains an explicit access mode and research baseline:

```ts
interface ResearchWorkspaceRepository {
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

The manifest stored in workflow context is authoritative. The sandbox copy must
match it field-for-field before clarification snapshots, repository expansion,
write promotion, implementation, and publication.

### 5. Iterative planning

After initial attachment, the normal research/planning phase runs against the
code workspace. Its structured output supports:

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
5. reruns planning with existing session memory and the expanded manifest.

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

## Plan-Approval Runs

Plan approval ends the planning run and starts implementation later as a fresh
run. A live sandbox is therefore not the contract between the two runs.

The approval record and approved-run payload persist:

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
- Agent CLIs are installed once per continuous run.
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
- An ambiguous ticket uses model discovery instead of immediately asking.
- Planning requests another repository and completes on the next round.
- A second expansion works; a third becomes clarification.
- Planning and implementation can use different agent providers in one
  workspace.
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

