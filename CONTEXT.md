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

**Validation Issue**:
An authoring error that prevents a Workflow Definition draft from being
deployed. A Validation Issue does not necessarily prevent an incomplete draft
from being saved. A block-level Validation Issue identifies its Block; a
workflow-level Validation Issue applies to the definition as a whole.
_Avoid_: Warning, runtime Execution Failure

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
