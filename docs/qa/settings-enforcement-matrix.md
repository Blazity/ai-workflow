Status: current
Last-verified: 2026-09-13

# Settings enforcement: production QA matrix

These probes ran against production commit
`b54d81f845f4c80f8a02b0f7e244aeaab5ef0f83` on deployment
`ai-workflow-p5pt0i5qf`. A verdict records only the evidence observed for that
probe. Delivery state does not determine a verdict.

## Matrix

| Probe | Key | Value set and restored, UTC | Observation | Verdict | Finding when not PASS |
|---|---|---|---|---|---|
| H2 active column | `COLUMN_AI` | No probe write. The stored value remained `Ai`. | AWP-166, run `wrun_01M2DA7VYBRP9ERT15P6AH9FFB`, planning attempt 3158, moved from 待办 to Ai at run start. The source log does not record the Ai status ID. | PASS | |
| H2 review column | `COLUMN_AI_REVIEW` | No probe write. The stored value remained `REVIEW`. | AWP-166, run `wrun_01M2DA7VYBRP9ERT15P6AH9FFB`, planning attempt 3158, moved to 审查, status ID `11418`, at completion. | PASS | |
| Clarification backlog | `COLUMN_BACKLOG` | No probe write. The stored value remained `To Do`. | AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`, attempt 3177, both bounced to 待办 on clarification at 12:12Z. The source log does not record the 待办 status ID. | PASS | |
| Review destination frozen at run start | `COLUMN_AI_REVIEW` | `REVIEW` changed to `QA Freeze Probe` at 12:11:37Z and restored to `REVIEW` at 12:21:34Z. | AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`, attempt 3177, both started before the change, resumed after clarification, and finished in 审查, status ID `11418`. | PASS | |
| Automatic capacity path | `MAX_CONCURRENT_AGENTS` | `20` changed to `1` at 12:09:07Z and restored to `20` at 12:19:49Z. | AWP-169 webhook at 12:11:47Z and the 12:15 poll created no run while two runs were live. The 12:30 poll created `wrun_01M2DBYZ3NA27SV52S9AMADJKN` at cap 20 without another transition. No attempt ID is recorded for this capacity probe. | PASS | |
| Manual capacity path | `MAX_CONCURRENT_AGENTS` | `20` changed to `1` at 12:09:07Z and restored to `20` at 12:19:49Z. | Manual `workflows.dispatch` started AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX` and AWP-168 run `wrun_01M2DARAHKMDHYVSHGAFNCNH60`. Planning attempts 3176 and 3177 were both running at 12:10:09Z. | FAIL | Manual `workflows.dispatch` does not honor the configured concurrency cap. |
| Saved-definition review shape | `ENABLE_REVIEW_PHASE` | Registry default `false` changed to `true` at 12:08:33Z. It was restored to `false` at 12:22:09Z, and the dashboard left a stored row holding the default. | Definition 14 version 10 produced the same nodes for AWP-167 and AWP-168 as control AWP-166: `trigger`, `prepare`, `planning`, `implementation`, `checks`, `finalize`, `open-pr`, `slack`, `status`. There was no review node. | PASS | |
| Repository memory switch | `ENABLE_REPO_MEMORY` | `true` changed to `false` at 12:08:33Z and restored to `true` at 12:21:34Z. | AWP-167 run `wrun_01M2DAR509D9W0A7J2J2VE9VBX`, attempt 3176, still hydrated and persisted `ai-workflow/memory/AWP-167.md`, matching control AWP-166 attempt 3158. Attempt logs do not expose the gated repository-memory prompt or distillation paths. | PARTIAL | The workspace session file is unconditional, so the registry claim that the switch gates every read and write is too broad; the gated paths were not externally observable. |
| MCP result ceiling | `MCP_MAX_RESULT_BYTES` | Registry default changed to `1024` at 12:22:30Z and restored to `524288` at 12:23:00Z. The dashboard left a stored row holding the default. | Within 30 seconds, `runs.stats`, `settings.get`, and `tickets.get` returned a digest with `truncated: true`; small `runs.get` output was unchanged. | PASS | |
| MCP read rate | `MCP_READ_RATE_LIMIT_PER_MINUTE` | Registry default changed to `2` at 12:22:30Z, restored to `120` at 12:23:00Z, set to `2` again at 12:24Z, and restored to `120` at 12:24Z. The dashboard left a stored row holding the default. | Four `runs.get` calls used the same tool within one minute. Calls one and two answered; calls three and four returned MCP error code `RATE_LIMITED`, with `retryAfterMs` `56136` and `55568`. | PASS | |
| MCP tool timeout | `MCP_TOOL_TIMEOUT_MS` | No value was changed. | No deterministic slow tool was available to probe from outside the service. | NOT_RUN | The timeout path had no production probe that could produce direct evidence. |
| Catalog activation setting | `catalog.activated` | No probe write. `settings.list` resolved the registry value as `false`. | The 12:25Z `settings.list` value was `false`, while production runs, including `wrun_01M2DA7VYBRP9ERT15P6AH9FFB`, reported `repositoryAccess.activated: true`. | FAIL | The registry-only key resolves independently of the catalog state and therefore reports the wrong activation value. |

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
reset operation, so `ENABLE_REVIEW_PHASE`, `MCP_MAX_RESULT_BYTES`, and
`MCP_READ_RATE_LIMIT_PER_MINUTE` retain stored rows whose values equal their
registry defaults.
