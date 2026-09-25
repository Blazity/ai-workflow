---
paths:
  - "apps/worker/src/memory/**"
  - "apps/worker/src/services/memory/**"
  - "apps/worker/src/engine/support/memory-runtime.ts"
  - "apps/worker/src/engine/steps/memory-steps.ts"
  - "apps/worker/src/engine/steps/repo-memory-steps.ts"
  - "apps/worker/src/engine/steps/repo-seed-steps.ts"
  - "integrations/mem0/**"
---

# Memory

Memory is a capability, and the built-in store is one provider of it
(`memory/builtin/adapter.ts`), a core module because it needs core's database
(ADR-010 decision 10). Three things bind every edit under these paths:

- **Core speaks observations, never documents.** `activeMemory()`
  (`engine/support/memory-runtime.ts`) answers `recall` and `observe`; no
  caller outside `memory/builtin/**` may import `db/repositories/memory.ts`,
  parse or render a stored document, or hold a version. The one exception is
  routing memory in `engine/pre-sandbox/steps/repo-selection.ts`, which is not
  on the port (reason: "S13 scope not taken" in
  `docs/plans/2026-09-18-integrations.md`).
- **No provider is a legitimate state, and it is not a refusal.** Zero
  connected memory integrations means the built-in store, resolved before any
  pin comparison. Making `builtin` something an admin has to connect would
  stop memory at deploy on every deployment that has it switched on.
- **A refusal is reported, never swallowed.** `activeMemory()` never throws and
  answers a refusal instead; every caller records it (`unavailable` on the
  step's result, a `memory_unavailable` observation on the run where a hook is
  in scope) so a run that ran without memory is not indistinguishable from the
  first run on a subject. ADR-010 decisions 21 and 22.

History: docs/archive/agent-notes/packages-and-adapters.md
