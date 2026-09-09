# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Evidence and Gates

**Never report a result you did not observe.**

Before editing, record the branch and the exact 40-character start SHA. Freeze the exact candidate SHA before verification. Never substitute a branch, tag, alias, deployment URL, or abbreviated SHA for a full one.

Delivery state (`planned`, `in_progress`, `implemented`, `merged`, `deployed`) and evidence verdict (`NOT_RUN`, `IN_VERIFICATION`, `PASS`, `FAIL`, `BLOCKED`) are independent axes. Never infer one from the other. Missing evidence is never a `PASS`, and a later result does not erase an earlier `FAIL`.

Before pushing, run the scope-aware gate:

```sh
pnpm run verify:changed
```

It resolves the base from the branch upstream, then `origin/HEAD`, then `origin/main`, and never fetches; pass `-- --base <ref>` to override. Enable it as a hook once with `git config --local core.hooksPath .githooks`, but only if that setting is currently empty. The gate is advisory and bypassable: `git push --no-verify` is an audited bypass, so record why it was used and do not report the gate as passed.

Pick the additional commands that match the changed surface, and record the exact command and its outcome:

```sh
git diff --check
pnpm run typecheck
(cd apps/worker && pnpm run validate:pre-sandbox)
(cd apps/worker && pnpm run validate:local-skills)
(cd apps/worker && pnpm run mcp:contract:check)
pnpm run test:ci
```

Also run the smallest test that reproduces the issue, then nearby regression tests as warranted. Root `pnpm test` and `pnpm build` are not local defaults; broad suites belong in CI.

Nothing enforces CI at merge time. `main` has no branch protection, by decision. A green run is evidence of correctness, never proof that a red candidate could not land.

Record newly discovered defects as separate Jira issues instead of silently widening the current slice.

The full gate ladder, evidence-bundle schema, Jira disposition rules, and release authority live in [docs/delivery-gates.md](docs/delivery-gates.md). Read that when preparing evidence, closing a ticket, or working on a release, not on every edit.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
