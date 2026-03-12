# Blazebot – Requirements Summary

## Overview

An automated AI development agent that picks up tickets, implements features end-to-end with TDD, runs code review in a loop, resolves conflicts, and hands a clean PR to a human for final approval.

---

## Core Behaviors

### 1. Ticket Monitoring

- Watches for tickets moved into the **AI** column
- Automatically begins work without human intervention

### 2. Context Gathering

- Has read access to the ticket (description, acceptance criteria, comments)
- Has read access to the full repository
- Has read access to project specifications/documentation
- Asks clarifying questions on the ticket before starting if needed

### 3. Model Routing

- If a model is specified via ticket label, uses that model
- If no label is present, selects the appropriate model automatically based on task complexity

### 4. Agent Sandbox

Each agent runs in an **isolated Docker container** — no direct access to production infrastructure.

#### Sandbox Setup

1. A new **feature branch** is created via the GitHub SDK
2. A Docker container is spun up with:
   - The repository checked out on the feature branch
   - A generated `requirements.md` file containing:
     - Ticket description, acceptance criteria, and comments from Jira/Linear/etc.
     - Questions and answers from any previous sessions (full conversation history)
     - Any user comments from the ticket
3. The agent's Git permissions are **scoped**: it can commit to its feature branch and create PRs — nothing else

#### Implementation Flow

1. The agent runs Claude Code or Codex with the prompt: `/using-superpowers, plan implementation of feature highlighted in requirements.md`
2. Enforces TDD — integration and e2e tests are required, not optional
3. _(NTH)_ Generates multiple independent implementations and selects the best one

#### Clarification Flow

If the agent determines something is unclear before or during implementation:

1. Posts clarifying questions as a **comment on the ticket** (Jira/Linear/etc.)
2. Moves the ticket to **Backlog** (or a column defined via environment variable)
3. Pings the **user who invoked the run** on the messaging adapter (Slack/Teams/etc.)
4. The agent pauses and the sandbox is torn down
5. When the user answers the questions on the ticket and moves it back to **AI In Progress**:
   - A new sandbox is created with full context: original requirements + previous questions + user answers from comments
   - The agent resumes work with complete conversation history

### 5. Implementation Completion & Code Review

When the agent finishes implementation:

1. The agent runs the `/requesting-code-review` skill inside the sandbox
2. A **pull request** is created from the feature branch
3. The ticket is moved from **AI In Progress** → **AI Review**

#### AI Review Phase

- External AI reviewers (CodeRabbit, Anthropic reviewer, and any other configured reviewers) handle the review automatically
- Blazebot does not participate in this phase — it only resumes when called back

#### Human Review & Fix Loop

**Human reviews AI reviewer comments on the PR:**

- 👍 on comments they agree with
- Adds their own comments if needed
- Moves ticket from **AI Review** → **AI In Progress**

**Agent picks up:**

- All 👍'd reviewer comments
- All human-written comments (every user comment is respected)
- Spins up a new sandbox with full context (PR diff, review comments, original requirements)
- Fixes all feedback in one pass

**Self-review loop:**

- Runs `/requesting-code-review` skill again
- If new comments from reviewers → repeat loop
- If no comments → proceed to conflict resolution

**Conflict resolution:**

- Merges target branch
- Resolves all conflicts in a single commit
- Runs `/requesting-code-review` skill again
- If new comments → repeat loop
- If no comments → proceed

**CI checks:**

- GitHub Actions must pass
- Notify user that the PR is ready for human final review

---

## Cross-Cutting Requirements

| # | Requirement |
| --- | --- |
| 1 | Every status update is pushed to the messaging adapter (Slack, Teams, etc.) |
| 2 | The coding agent prompt must be refineable and support reusable **skills** (modular prompt building blocks) |
| 3 | All PRs and commits are authored as **Blazebot** |
| 4 | The workflow definition is **versioned in code** (code-first, not config UI) |
| 5 | **Adapter modularity** — all external integrations (Jira, Slack, GitHub, etc.) must be behind clearly isolated adapter interfaces, so swapping e.g. Jira → Linear/Asana or Slack → Teams is a single-module replacement with no changes to core logic |
