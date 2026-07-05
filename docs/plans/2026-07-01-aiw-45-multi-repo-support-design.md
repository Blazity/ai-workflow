# AIW-45 multi-repo support design

**Date:** 2026-07-01
**Status:** Approved design
**Base branch:** `origin/dev` at `198a8a5`
**Branch/worktree:** `codex/aiw-45-multi-repo-support` at `.worktrees/aiw-45-multi-repo-support`

## Goal

Stop assuming one repository per workflow run. A run should select the relevant
repositories before sandbox provisioning, clone only those repositories, let the
agent work across them in one Run Workspace, and create one PR/MR per changed
repository.

## Existing context

`origin/dev` includes AIW-32 GitLab parity, so GitHub and GitLab both support
the current single-repository workflow surface. The remaining gap is the
workflow and sandbox model: env/config, VCS construction, branch setup,
sandbox provisioning, commit guards, push, PR/MR creation, and Jira comments
still assume one configured repository.

The roadmap and estimate docs define the intended baseline:

- List Accessible Repositories through provider APIs.
- Add a pre-sandbox repo-selection step.
- Select from ticket/task context plus provider repo metadata.
- Clone only Selected Repositories.
- Track cloned repositories, Changed Repositories, branch names, push status,
  Workflow-Owned Branch records, and PR/MR links.
- Post one Jira comment with all PR/MR links.
- Defer clone-on-demand runtime tooling unless pre-sandbox selection proves
  insufficient.

## Non-goals

- No multiple accounts per provider kind in v1. A deployment supports at most
  one GitHub App installation config and one GitLab host/token config, but both
  provider kinds can be enabled together.
- No deep code indexing, repository knowledge graph, or cross-repo memory/KB.
- No automatic lint/test command discovery.
- No full runtime clone-on-demand tool in AIW-45.
- No manual repo list as the source of truth for which repos exist. Provider
  permissions define Accessible Repositories; manual config belongs to later
  per-repo check commands/hooks.

## Chosen approach

Use the hybrid architecture: implement AIW-45 as deterministic pre-sandbox
selection plus a durable repo manifest, while shaping the Run Workspace so
runtime repo tools can be added later without redesigning push and PR/MR
tracking.

The first implementation does not expose provider tokens or clone tools to the
agent. The server-side workflow lists Accessible Repositories, chooses the
Selected Repositories, creates branches, provisions the sandbox, and injects
tokens only after agent phases have exited for push operations.

## Architecture

Add a provider-neutral repository directory layer. It lists Accessible
Repositories across every configured provider and normalizes metadata into a
single internal shape: provider, repo path/project ID, display name, default
branch, description, owner/namespace, and optional topics/tags when available.

Keep GitHub and GitLab adapters as per-repo adapters for branch, PR/MR, review,
status, and file operations. Multi-repo orchestration should construct a
per-selected-repo adapter/config rather than turning the existing adapter into a
global singleton.

Add a pre-sandbox selector step that receives ticket context, Workflow-Owned
Branch records, and normalized repo metadata. It returns selected repository
IDs plus rationale. If it cannot select any repository, the workflow asks for
clarification instead of silently choosing a default repository.

Provision one sandbox containing a Run Workspace with Selected Repositories
cloned under stable paths, for example:

```text
/vercel/sandbox/
  repos/
    owner__api/
    owner__web/
  aiw-repos.json
```

The manifest is the workflow's source of truth for cloned Selected
Repositories:

```ts
interface RepoWorkspaceEntry {
  provider: "github" | "gitlab";
  repoPath: string;
  localPath: string;
  defaultBranch: string;
  branchName: string;
  preAgentSha: string;
  workflowOwnedBranch?: {
    branchName: string;
    pr?: { id: number; url: string; branch: string };
  };
  selectedRationale: string;
}
```

Post-phase logic enriches this state with changed status, push result, and
created/reused PR/MR links on Workflow-Owned Branch records.

## Data flow

1. Fetch and validate the Jira ticket.
2. Compute the feature branch name once from the ticket key.
3. List Accessible Repositories for the active VCS provider.
4. Load Workflow-Owned Branches for the ticket from durable ownership records.
   Branch-name matches are not enough to prove ownership.
5. Run the repo selector with ticket data, repo metadata, and Workflow-Owned
   Branch context.
6. Force-include repositories that already have a Workflow-Owned Branch for the
   ticket. This protects review-feedback reruns even when metadata alone would
   not select the repository.
7. Create or reset the feature branch in each Selected Repository when there is
   no Workflow-Owned Branch for that repository. Preserve Workflow-Owned
   Branches on reruns.
8. Provision the sandbox with the bootstrap Selected Repository at the sandbox
   root, then clone additional Selected Repositories under `repos/<stable-slug>`.
9. Write `aiw-repos.json` with each repo's local path, branch, default/base
   branch, pre-agent SHA, provider, repo path, and selection rationale.
10. Run research, implementation, and optional review once against the
    multi-repo Run Workspace.
11. Scan manifest repositories for changed HEADs and dirty working trees.
12. Push only Changed Repositories.
13. Create or reuse one PR/MR per Changed Repository, and persist PR/MR metadata
    onto the Workflow-Owned Branch records.
14. Post one Jira comment containing all PR/MR links.
15. Move the ticket to review and emit the normal notification with the primary
    PR/MR context plus all links.

## Error handling

- If provider repo listing fails, fail before sandbox provisioning and move the
  ticket back with a clear pre-sandbox failure.
- If the selector returns no repos, ask for clarification.
- If a selected repo cannot be branched or cloned, fail before the agent runs.
- If the agent changes no repos, fail with the existing "made no commits" guard
  generalized across all manifest repos.
- If any changed repo fails to push or open a PR/MR, treat the run as failed
  rather than moving the ticket to review with a partial result.
- Do not force-select a repository just because it has a matching branch name.
  Force-inclusion requires a Workflow-Owned Branch record.
- Commit guards must check every cloned repo, not only the current working
  directory.
- Provider tokens must remain server-side. The agent never receives clone/push
  credentials; push tokens are injected only after the agent process exits.

## Future runtime repo tools

The manifest and Run Workspace layout should make clone-on-demand possible later.
A future runtime tool can add an entry to the same manifest and clone into the
same `repos/<stable-slug>` layout. AIW-45 should not implement that tool, but
it should avoid hardcoding assumptions that only the initially selected repos
can ever exist.

A possible follow-up flow:

1. Research or implementation asks for another repo through a structured
   request.
2. The server-side workflow validates access and clones the repo.
3. The manifest is updated.
4. The agent resumes with the new repo available.

## Testing

Use TDD around the new contracts.

Provider discovery:

- GitHub lists accessible installation repositories with normalized metadata.
- GitLab lists accessible projects with normalized metadata.
- Provider metadata maps to the same internal repository shape.

Pre-sandbox selection:

- Selects repos from ticket text plus metadata and returns rationale.
- Returns clarification when no repo can be selected.
- Force-includes repositories with Workflow-Owned Branch records on reruns.

Sandbox and Run Workspace:

- Clones multiple Selected Repositories under deterministic local paths in the
  Run Workspace.
- Writes the repo manifest.
- Configures git identity and pre-agent SHA per repo.

Commit guard and push:

- Detects no commits across all repos.
- Detects Changed Repositories only.
- Pushes Changed Repositories only.
- Creates or reuses one PR/MR per changed repo and records it on the
  Workflow-Owned Branch.

Workflow orchestration:

- Posts one Jira comment with all PR/MR links.
- Does not provision a sandbox when selection fails.
- Keeps provider token injection after agent exit.

Verification:

- Run targeted worker tests for discovery, selector, sandbox/Run Workspace, and
  push/PR orchestration first.
- Run `pnpm --filter worker typecheck`.
- Run `pnpm --filter worker test` when dependency setup is available.

## Open implementation decisions

- Exact selector implementation: deterministic keyword/rule selector first,
  LLM selector through the existing pre-sandbox framework, or a hybrid with a
  deterministic fallback.
- Exact GitHub repo listing endpoint and pagination strategy for installation
  repositories.
- Exact GitLab project listing scope and pagination strategy for token-visible
  projects.
- How the Slack/telemetry `pr` field should represent multiple PR/MR links
  before the API contract grows a first-class array.
