Status: current
Last-verified: 2026-09-13

# Settings enforcement: production QA matrix

These probes ran against production commit
`b54d81f845f4c80f8a02b0f7e244aeaab5ef0f83` on deployment
`ai-workflow-p5pt0i5qf`. A verdict records only the evidence observed for that
probe. Delivery state does not determine a verdict.

The current catalog contains 26 keys, counted from
[`SETTINGS_REGISTRY`](../../packages/contracts/settings-registry.ts). The
matrix has one row per catalog key. Settings stage S1 removed the eight keys
without a settings-owned behavior, and S2 retired the harness trio
`AGENT_KIND`, `CLAUDE_MODEL`, and `CODEX_MODEL`; those names are not active
catalog keys and therefore are not rows here. Existing production observations
are retained only for the surviving key they actually exercised.

## Matrix

| Probe | Key | Value set and restored, UTC | Observation | Verdict | Finding when not PASS |
|---|---|---|---|---|---|
| Catalog coverage | `DASHBOARD_ORG_NAME` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `DASHBOARD_ORG_SLUG` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Automatic and manual capacity paths | `MAX_CONCURRENT_AGENTS` | `20` changed to `1` at 12:09:07Z and restored to `20` at 12:19:49Z. | AWP-169 webhook at 12:11:47Z and the 12:15 poll created no run while two runs were live; the 12:30 poll created `wrun_01M2DBYZ3NA27SV52S9AMADJKN` at cap 20. In contrast, manual `workflows.dispatch` started AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX` and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`; planning attempts 3176 and 3177 were both running at 12:10:09Z. | FAIL | Manual `workflows.dispatch` does not honor the configured concurrency cap. |
| Catalog coverage | `JOB_TIMEOUT_MS` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `V2_MAX_BLOCK_CONCURRENCY` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `ATTACHMENT_MAX_FILE_SIZE_MB` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `ATTACHMENT_MAX_TOTAL_SIZE_MB` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `ATTACHMENT_MAX_COUNT` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `ATTACHMENT_DOWNLOAD_TIMEOUT_MS` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Repository memory switch | `ENABLE_REPO_MEMORY` | `true` changed to `false` at 12:08:33Z and restored to `true` at 12:21:34Z. | AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, still hydrated and persisted `ai-workflow/memory/AWP-167.md`, matching control AWP-166 attempt 3158. Attempt logs do not expose the gated repository-memory prompt or distillation paths. | PARTIAL | The workspace session file is unconditional, so the gated paths were not externally observable. |
| Catalog coverage | `ENABLE_ORG_MEMORY_PROMOTION` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `ENABLE_REPO_ROUTING_MEMORY` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `REVIEW_LEDGER_ENABLED` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `MCP_ENABLED` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `MCP_ALLOW_PUBLIC_DCR` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `MCP_AUDIT_RETENTION_DAYS` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `MCP_MAX_REQUEST_BYTES` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| MCP result ceiling | `MCP_MAX_RESULT_BYTES` | Registry default changed to `1024` at 12:22:30Z and restored to `524288` at 12:23:00Z. The dashboard left a stored row holding the default. | Within 30 seconds, `runs.stats`, `settings.get`, and `tickets.get` returned a digest with `truncated: true`; small `runs.get` output was unchanged. | PASS | |
| MCP tool timeout | `MCP_TOOL_TIMEOUT_MS` | No value was changed. | No deterministic slow tool was available to probe from outside the service. | NOT_RUN | The timeout path had no production probe that could produce direct evidence. |
| MCP read rate | `MCP_READ_RATE_LIMIT_PER_MINUTE` | Registry default changed to `2` at 12:22:30Z, restored to `120` at 12:23:00Z, set to `2` again at 12:24Z, and restored to `120` at 12:24Z. The dashboard left a stored row holding the default. | Four `runs.get` calls used the same tool within one minute. Calls one and two answered; calls three and four returned MCP error code `RATE_LIMITED`, with `retryAfterMs` `56136` and `55568`. | PASS | |
| Catalog coverage | `MCP_MUTATION_RATE_LIMIT_PER_MINUTE` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `PRE_PR_COMMAND_TIMEOUT_MINUTES` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| Catalog coverage | `PRE_PR_CHECKS_ALLOWED_ENV` | No production probe observed. | No direct production observation was recorded for this key. | NOT_RUN | No production evidence. |
| H2 active column | `COLUMN_AI` | No probe write. The stored value remained `Ai`. | AWP-166, run `wrun_01M2DA7VYBRP9ERT15P6AH9FFB`, planning attempt 3158, moved from 待办 to Ai at run start. The source log does not record the Ai status ID. | PASS | |
| H2 review column and run-start freeze | `COLUMN_AI_REVIEW` | The stored value began at `REVIEW`, changed to `QA Freeze Probe` at 12:11:37Z, and was restored to `REVIEW` at 12:21:34Z. | AWP-166 moved to 审查, status ID `11418`, at completion. AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`, attempt 3177, both started before the change, resumed after clarification, and also finished in status ID `11418`. | PASS | |
| Clarification backlog | `COLUMN_BACKLOG` | No probe write. The stored value remained `To Do`. | AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`, attempt 3177, both bounced to 待办 on clarification at 12:12Z. The source log does not record the 待办 status ID. | PASS | |

The successful rate-limit probe also narrows the contract: the window is keyed
per organization, actor, client, and tool name in
`services/mcp/rate-limit-store.ts:67-74` and
`db/repositories/mcp.ts:97-102`. The registry text says "per client", but five
reads across five different tools were admitted because each tool had its own
window.

## How settings were written

On the DCR token used for these probes, MCP `settings.set` and
`settings.reset` both returned `INSUFFICIENT_SCOPE`. Settings were therefore
written through the dashboard `PATCH /api/settings` route. That route has no
reset operation, so at the time of the probe the surviving MCP keys retained
stored rows whose values equaled their registry defaults.
