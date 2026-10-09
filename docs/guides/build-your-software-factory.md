Status: current
Last-verified: 2026-10-09

# Build your software factory

This guide takes a team from a fresh AI Workflow deployment to two working lines: one that turns tickets into reviewed pull requests, and one that keeps those pull requests moving after review. It assumes the deployment from [SETUP.md](../../SETUP.md) is up and you can sign in to the dashboard. Every step names the dashboard screen and the MCP tool that does the same thing, so you can follow it by hand or from your own agent.

## What you are building

A software factory here is a set of workflows. Each workflow is a line, and each block on it is a station. The product's own words are in the second column; the [glossary](../../CONTEXT.md) defines them.

| Factory word | Product word | Where you see it |
|---|---|---|
| Line | Workflow definition | Workflow editor |
| Station | Block | The canvas, and the block palette on its left |
| Work order | Ticket, or a pull request for PR workflows | Jira, GitHub, GitLab |
| One pass down the line | Run | Workflow runs, and the run trace |
| Worker setup | Harness profile (model, skills, tools) | Harness profiles |
| Inspection | Run scripts, Leak review, Review agent | Blocks on the canvas |
| Supervisor checkpoint | Human question, Send plan for approval | Jira comments, Approvals |

People stand at three kinds of checkpoint: a question the planning agent asks in the ticket, a plan approval, and the pull request review. You decide per workflow which of these exist. AI Workflow has no merge step, so the merge is always a person's.

## Before you start

Open **Settings → System health** and run a scan. It shows which integrations are connected, whether the agent keys work and whether the webhooks are registered. Fix what it flags first; a line that starts with a broken integration fails at its first station.

Then add the repositories the agents may work in under **Repositories**. Once the catalog is activated, a repository that is not switched on there cannot be entered by any run. MCP: `repositories.import_preview`, `repositories.import`, `repositories.set_enabled`.

## Line 1: from ticket to an approved plan

Start with the line that asks the most of people, then remove checkpoints as you learn to trust it.

1. In the **Workflow editor**, open **Human-approved plan** and enable it. MCP: `workflows.list`, `workflows.set_enabled`.
2. Check the board columns under **Settings**. A ticket that enters the `AI` column starts the run, a finished ticket moves to `AI Review`, and a ticket that needs answers goes back to `Backlog`. Each column name can be overridden per trigger.
3. Move a real ticket into the AI column. The planning agent reads it and the repositories it may touch. If the ticket leaves something open, the agent posts its questions in the ticket and the run waits.
4. Answer in the ticket, in the run's page in the dashboard, or through MCP (`runs.get_clarification`, `runs.answer_clarification`). The run resumes with your answer.
5. The plan arrives in **Approvals**. Read it and approve or reject it. MCP: `approvals.list`, `approvals.approve`, `approvals.reject`. Approval starts the implementation path, which ends in a pull request.

To try a line on one ticket without waiting for the board, press **Run trigger** on its trigger node in the editor and enter the ticket key. MCP: `workflows.dispatch_preflight`, then `workflows.dispatch`.

## Add quality gates

A pull request should reach a person only after it passes the checks your team already trusts.

- **Repository scripts.** Each repository gets named script groups (setup, lint, test and so on) under **Repositories**. The **Run scripts (publication gate)** block runs the groups you mark as gating, and a red group stops publication. The contract is in [repository scripts](../architecture/repository-scripts.md). MCP: `repositories.upsert`.
- **Leak review.** Put a **Leak review** block before **Open PR/MR** to screen the unpushed diff for secrets.
- **Review agents.** **Reviewed ticket workflow** runs security, code quality and requirements reviews in parallel, branches on their verdict, and sends findings to a fix agent in a loop of up to three attempts. Start from it when you want reviews before the pull request exists.

## Line 2: keep pull requests moving

The second line starts where the first one ends. It needs the VCS webhook from [SETUP.md](../../SETUP.md#8-register-the-vcs-webhook).

- **Review & fix after PR** responds to failed checks and requested changes on pull requests a workflow opened.
- **Post-PR review** reviews ready and updated pull requests, publishes findings and completes a check on the exact commit it reviewed. It also works on pull requests people wrote, and it needs no tracker.
- **Post-PR review with autofix** reviews, fixes findings in a bounded loop and publishes one final review.

Try one on an existing pull request first: **Run trigger** on its "PR ready for review" node, then paste the pull request URL.

## Tune the stations

- **Harness profiles** set the model, its reasoning effort, the tools and the skills an agent gets. A workflow node pins an exact profile version, so publishing a new profile version changes nothing until you point the node at it. MCP: `profiles.list`, `profiles.get`, `profiles.publish`.
- **Prompts** holds the block prompts with their version history. A change is a new version you can compare and restore. MCP: `prompts.list`, `prompts.get`, `prompts.update`.
- **Memory** keeps what agents learned about each repository. Forget an entry there when it is wrong. MCP: `memory.list`, `memory.get`, `memory.forget`.
- **Execution limits** in the editor cap one run's duration, tokens and cost.

Every change to a workflow is a draft until you deploy it, and the editor keeps the version history. Runs in flight keep the version they started with.

## Watch the factory

- **Workflow runs** lists every run with its status. The run trace shows each block's input, output, logs and timing, with a visual replay of the path the run took.
- The **Briefing** tab on a block shows the exact prompt that agent received, section by section, with the source of each part. When an agent does something odd, read this first. MCP: `runs.briefing`.
- **Cost & usage** breaks spend down per workflow and per day. MCP: `runs.stats`.
- From your own agent, `runs.diagnose` classifies why a run stopped and `runs.logs` returns the raw provider error. Connect it as described in [Remote MCP](../../SETUP.md#remote-mcp--connect-your-agent).

## Give a line more room

Remove a checkpoint only when the runs show it no longer catches anything. Before you drop the plan approval from a line, read a handful of its recent plans and briefings and check how many you changed or rejected. Before you let a line fix its own review findings, check that its fixes have been passing your repository scripts. Each workflow moves on its own, so routine tickets can run further while risky areas keep every checkpoint.

## Extend the factory

- **Webhooks.** The **Webhook** trigger accepts signed deliveries from other systems. **Ticket triage (webhook)** and **Support investigation (Zendesk + Sentry)** are starting points. Setup is in [SETUP.md](../../SETUP.md#webhook-trigger).
- **Schedules.** The **Schedule** trigger runs a workflow on a cron expression in a timezone you set.
- **A new provider.** Each third party is one package under `integrations/`. [Writing an integration](../architecture/integrations.md) covers the steps, and the repository's `new-integration` skill walks through them.
- **Authoring from an agent.** `workflows.create`, `workflows.save_draft` and `workflows.publish` accept the same graph the editor saves, and `blocks.list` and `blocks.get` describe every block's inputs and outputs.

## What is not here yet

- Execution runs on Vercel only.
- Jira is the only issue tracker; Linear is not supported.
- Proven workflows cannot yet be promoted across teams, and budgets are per run, not per organization.
- AI Workflow never merges a pull request.

The dated plan for these is the [roadmap](../product/roadmap-2026-08-27.md).
