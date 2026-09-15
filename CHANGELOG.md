# Changelog

This file lists what changed for people using AI Workflow, newest first.
Entries are written in the pull request that ships the change and collected
automatically from `changelog/unreleased/` once a day; see `changelog/README.md`.

## 2026-09-15

- Planning moves on with the repositories already in the workspace instead of asking for them again: when every repository the planner names is already attached the run goes straight to planning, a reply of "none" or "no more repositories" to a repository question settles it for the rest of the run, and every repository question a run asks accepts the same answer format.
- When planning asks for a repository the run cannot use, the question now says so plainly: enable it on the Repositories page and start a new run, name another repository to add, or reply "none" to continue without it, and the run stops if the agent cannot plan without it. A run asks a person about each such repository once, and a "none" posted as a Jira comment settles it.
- A pasted GitHub or GitLab link in the answer picks the repository on that provider: a link to a GitHub repository is never matched to a GitLab repository of the same name, and the person is asked instead.
- A run carries its workflow identity from the moment it is claimed, so the dashboard runs list, the trace header and `runs.get` name the workflow while the run is still in progress.
- `completionPending` on `runs.get`, `runs.result` and `tickets.list_runs` now covers the whole window between a run reaching success and its cost, phases and pull requests being recorded, so an integration polling through MCP waits for the pull request data instead of reading a finished run that reports none.
- A finished run now says whether its cost, phases and pull requests have been recorded yet: `runs.get`, `runs.result` and `tickets.list_runs` carry `completionPending`, `runs.result` waits for that data before reporting success and tells the caller when to poll again, `runs.diagnose` names the state, and the trace header in the dashboard labels the duration while the data is still pending.
- `runs.cancel` on a run that has already finished answers `already_terminal` and frees its ticket for the next run, so an integration can clean up after a finished run through MCP without waiting for the scheduled sweep.
- Right after a run finishes, `runs.cancel` answers with a retryable conflict for a short moment while the run wraps up, and a retry with the same idempotency key completes the call.
- When a finished run's ticket or claim cannot be cleaned up yet, `runs.cancel` answers with a retryable conflict that says the run has finished and nothing was changed, instead of reporting a run that is done as still live.

## 2026-09-14

- Run capacity limits now apply no matter how a run starts: from the dashboard, a trigger, or an MCP tool.
- The dashboard, API and MCP now show why a repository suggestion could not complete.

## 2026-09-13

- Run capacity, timeouts, block limits and other operational settings now live entirely on the dashboard Settings page.
- Harness profiles now set their own provider and model, and are validated against that provider before a workflow can use them.
- Repositories can now declare relationships to each other with a fixed set of kinds, and each repository's rules and description can be written and edited from the dashboard, with unknown variables rejected on save.

## 2026-09-12

- The dashboard has a new Settings page for operational controls such as run capacity, timeouts and block limits.
- The dashboard has a new Repositories page: import a repository from your provider, add a description, and see suggested profiles for it.
- New MCP tools cover the repository catalog and settings: list, read and update them the same way the dashboard does.

## 2026-09-09

- A run waiting on a clarification is now cancelled automatically once its ticket no longer exists.
- After an answer, a run gets a limited number of automatic resume attempts, then a clear status explains that a new run is needed.
