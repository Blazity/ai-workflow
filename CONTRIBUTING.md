# Contributing to AI Workflow

Thanks for helping. This file covers what you need to open a pull request that can merge. How the code is laid out and why is in [AGENTS.md](./AGENTS.md) and [the documentation index](./docs/index.md).

## Set up

AI Workflow is a pnpm workspace. You need Node.js 20 or newer and pnpm 10 or newer.

```bash
pnpm install
pnpm dev                 # the worker
pnpm dev:dashboard       # the dashboard
```

Running real workflows needs a deployment with its accounts and environment variables. [SETUP.md](./SETUP.md) lists them, and `apps/worker/AGENTS.md` and `apps/dashboard/AGENTS.md` describe running each app locally.

Do not run `pnpm build` locally. The worker build applies database migrations to whatever `DATABASE_URL` points at.

## Before you open a pull request

- Reproduce a bug with the smallest test you can, make it pass, then run the tests near your change. One package or one file is the usual loop; the full suites run in CI.
- Run the checks that match what you changed:

  ```bash
  git diff --check
  pnpm run typecheck
  pnpm run verify:changed  # plans and runs the gates for the paths you touched
  ```

- A change under `apps/`, `packages/` or `integrations/` needs a changelog entry in `changelog/unreleased/`, written for the people who use the product. [changelog/README.md](./changelog/README.md) explains the format. Internal changes take the `changelog: skip` label instead.
- Fill in the pull request template: what changed, what it means for users, and how you verified it.

## Conventions

- Branches are `type/kebab-case-description`, for example `feat/media-upload-drag-drop`. Types: `feat`, `fix`, `chore`, `refactor`.
- Commits are one line, `type(scope): message`, in the imperative, under 72 characters. Take the scope from `git log --oneline`.
- Everything in git is in English.
- `main` requires the `ci` check to pass.

## Coding agents

If you work with Claude Code, Codex or another agent, point it at [AGENTS.md](./AGENTS.md). It routes the agent to the right document and carries the rules that bind every edit, including four production gotchas that unit tests do not catch.

## Security issues

Do not open a public issue for a vulnerability. Follow [SECURITY.md](./SECURITY.md).
