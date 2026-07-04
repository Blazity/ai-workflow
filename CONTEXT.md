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

**Selected Repository**:
An accessible repository chosen for a specific workflow run. One workflow run
has one or more selected repositories.
_Avoid_: Active repo, target repo

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

**GitLab Project**:
A GitLab collaboration container that owns settings and features around one
primary source repository.
_Avoid_: Treating GitLab project as synonymous with every Git-backed object under it

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
