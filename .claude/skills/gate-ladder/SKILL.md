---
name: gate-ladder
description: Use when selecting, running, or evidencing the repository verification gates before delivery.
---

# Gate ladder

Read [G0 through G6 and the evidence authority](../../../docs/delivery-gates.md) for the current delivery contract.

Read the [static ladder and required CI rules](../../../docs/adr/ADR-004-gates-and-required-ci.md) before deciding which checks are required.

Use the repository commands for execution:

- `pnpm run verify:changed -- --base <ref>` for the scope-aware check.
- `pnpm run gates` for the static gate ladder.
- `pnpm run test:ci` for the focused CI gate tests.
- `git diff --check` for whitespace errors.

Keep the evidence bundle and pass or fail interpretation in the authoritative documents linked above. This skill is only the routing point for those procedures.
