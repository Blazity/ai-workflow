---
name: review-checklist
description: House rules the reviewer applies to every pull request. Copy this directory into skills/ at the repository root and rewrite it for your own conventions.
---

# Review checklist

Everything below the front matter is ordinary Markdown, loaded into the agent
when a profile pins this skill.

## What to check

- Every changed line traces back to the ticket.
- No new dependency without a note explaining why the standard library is not
  enough.
- Tests cover the failure the change fixes, not only the happy path.

## Extra files

A skill may ship further files beside `SKILL.md`, in subdirectories if that
helps. They travel with the artifact and land next to it in the sandbox, so
refer to them by their path relative to this file, for example
`references/api.md`.

> This directory lives under `docs/` on purpose. A copy under `skills/` would be
> discovered as a real skill of this deployment and offered for import, which
> would blur the difference between "this deployment ships no skills" and "it
> ships one example".
