# Live Prompt References Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add latest/pinned live prompt includes, deterministic recursive runtime resolution, run audit data, and reference-aware editor actions.

**Architecture:** Store canonical `{{prompt:id}}` / `{{prompt:id@version}}` directives inside existing markdown strings. Resolve every workflow node in a run-start durable step, then use the existing per-block variable substitution. Render library metadata around raw tokens in the dashboard without introducing a second persisted content model.

**Tech Stack:** TypeScript, React 19, Next.js 15, Nitro/Vercel Workflow, Drizzle/Postgres, Vitest, node:test.

## Tasks

- [ ] Add shared token contracts and formatter/parser exports.
- [ ] Add a pure recursive resolver with cycle/depth/size checks and tests.
- [ ] Add a durable run-start resolver backed by prompt-library version reads.
- [ ] Persist the resolved prompt manifest in workflow-run telemetry.
- [ ] Integrate latest/pinned insertion and detach behavior in the prompt library/editor.
- [ ] Integrate atomic reference blocks with the section composer drag model.
- [ ] Run worker/dashboard tests, typechecks, production builds, diff checks, and focused manual UX verification.

## Global constraints

- Existing copied prompts and `promptRefs` remain backward compatible.
- `Latest` is frozen to one concrete version per run; pinned versions never float.
- Prompt includes recurse; global run-variable values do not.
- Whole prompts reference; individual sections copy.
- Missing/cyclic/invalid references fail before an agent call with a clear error.
- No worktree and no unrelated cleanup.
