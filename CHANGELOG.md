# Changelog

This file lists what changed for people using AI Workflow, newest first.
Entries are written in the pull request that ships the change and collected
automatically from `changelog/unreleased/` once a day; see `changelog/README.md`.

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
