# Evidence screenshots

Screenshots captured live from the `ai-workflow-demo` preview dashboard and GitHub
during the end-to-end block coverage run (see `../e2e-test-report.md`). Drop the PNGs
here with these exact names so the report renders them:

| File | What it shows |
|---|---|
| `01-runs-table.png` | `/runs` — 17 runs in 24h, Status / Model (`gpt-5.4-mini`) / Cost columns |
| `02-editor-palette.png` | Workflow editor with the default graph and the full block palette (all block groups) |
| `03-graph-approval.png` | `e2e-approval` definition — the two-chain plan-approval graph |
| `04-graph-loop.png` | `e2e-loop` definition — Loop block with `continue` / `retry` / `exhausted` ports |
| `05-live-running-planning.png` | Editor in **LIVE** mode: header `AWT-1021 · LIVE · Running: planning`, per-block status dots on the canvas (the "agent is in this step" view) |
| `06-approvals.png` | `/approvals` — `AWT-1015 APPROVED` |
| `07-cost.png` | `/cost` — 24h spend, tokens, per-workflow breakdown |
| `08-pr-checks-failed.png` | GitHub PR #293 — the failing check `e2e-fail-1018` and the bot's `post_pr_comment` result |
