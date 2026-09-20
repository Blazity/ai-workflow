---
paths:
  - "packages/agent-visibility/**"
  - "apps/worker/src/engine/agent-visibility/**"
  - "apps/worker/src/services/agent-visibility/**"
  - "apps/worker/src/run-observability/agent-briefings.ts"
  - "apps/worker/src/run-observability/visibility-detector.ts"
  - "apps/worker/src/db/schema/agent-visibility.ts"
  - "apps/worker/src/db/repositories/agent-visibility.ts"
  - "apps/worker/src/repository-map/**"
  - "apps/worker/src/mcp/tools/briefings.ts"
  - "apps/worker/src/routes/api/v1/runs/briefing-route.ts"
  - "apps/dashboard/lib/agent-visibility/**"
  - "apps/dashboard/components/cockpit/agent-visibility/**"
---

# Agent visibility

- **Capture never fails a run.** The send steps keep `maxRetries = 0`
  (`engine/steps/phase.ts`), so a throw while recording would kill an agent
  that is already starting. Catch everything, log it with the run and the
  attempt, return an outcome, rethrow nothing.
- **Two halves, and the split is not decoration.** `engine/agent-visibility/plan.ts`
  runs in workflow scope: pure, no database, no clock, no environment, because
  the isolate must replay to the same bytes. `capture.ts` runs inside the step
  body and reaches the database through a deferred import. The plan argument
  never carries the prompt again: the step already holds it, and the DevKit
  journals every argument.
- **The write lives in `run-observability/`, not in the service cluster.** The
  engine may not import a service (ADR-001, `scripts/gates/tiers.json`), so
  `run-observability/agent-briefings.ts` owns `recordAgentBriefing` and
  `services/agent-visibility/index.ts` re-exports it for the read surfaces.
- **Every read-side vocabulary is open.** The worker and the dashboard deploy
  separately, so a value one build has never heard of has to parse and render
  as itself (`packages/agent-visibility/vocabulary.ts`). A closed enum on the
  read side turns the first new repository state into a dashboard that cannot
  open any briefing at all. The write side is closed: the builder refuses an
  unknown kind.
- **Redaction happens once, at capture.** Stored text is already redacted and
  already normalized so that the MCP serve-time sanitizer
  (`mcp/sanitize-result.ts`) leaves it unchanged. Redacting again at read time
  makes the dashboard and MCP disagree by a byte, which is the one failure this
  feature exists to prevent. The detector reports positions and never rewrites,
  so everything outside a reported span is what the model was really sent.
- **Record what was rendered, never re-read it.** The structured repository
  context comes from the same pass over the same input that produced the
  rendered map (`repository-map/map.ts`). A second read of the catalog would
  answer "what does the catalog say now", which looks identical and is a
  different question.
- **The map lives in `apps/worker/src/repository-map/`** because `sandbox/` and
  `engine/` both import it and the engine already imports `sandbox/`; inside
  `engine/` it would close that loop.
- **Pages cursor on an append-only key**, never on a position: a positional
  cursor over a live run serves one item twice and skips another with nothing
  red anywhere. The MCP budget is measured on the whole result, not on the
  page, because the envelope goes out twice (a text block and
  `structuredContent`): see `mcp/tools/page-budget.ts`.
- **A missing briefing always says which kind of missing.** Whether the prompt
  went out is decided first, and only then whether we kept it; "not recorded"
  is never the answer for a run that died before sending.

Plan and decisions: [docs/plans/2026-09-19-agent-visibility.md](../../docs/plans/2026-09-19-agent-visibility.md).
