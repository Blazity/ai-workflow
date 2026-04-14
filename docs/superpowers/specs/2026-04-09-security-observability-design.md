# Security Observability Spec

Security observability for the AI workflow system (AWS on-prem).

Target deployment: AWS on-prem architecture (Fargate agents, EC2 Nitro server). Architecture should be cloud-agnostic via adapters — AWS is first implementation.

All explicit threshold values, file paths, and integration details are preliminary and need to be validated against production data. Review after first month of real usage.

## Threat Categories

### 1. Prompt Injection

Detect adversarial instructions injected into the LLM context from untrusted sources.

**Vectors:**

- Jira ticket descriptions and comments — scanned before they become part of the prompt (pre-phase input gate)
- WebFetch responses — every fetched web page scanned for injection patterns before entering LLM context (during agent execution)
- PR review comments — scanned before the review-fix cycle begins (pre-phase input gate)

**Detection:** Arthur Engine Prompt Injection evaluation (DeBERTa v3 classifier).

**Response:** Critical — kill sandbox, cancel workflow, Slack alert with details.

### 2. Data Exfiltration & Network Monitoring

Detect unauthorized outbound communication from agent sandboxes. The primary fear: a prompt-injected agent exfiltrating source code or secrets to an attacker-controlled server.

**Checks:**

- Outbound connections — every TCP connection from Fargate agents via VPC Flow Logs on `sg-fargate`
- DNS queries — domain names the agent resolves via VPC DNS query logging
- Traffic volume — bytes uploaded per connection via VPC Flow Logs aggregation
- Large uploads — unusual outbound data volume (e.g., >10MB to a single IP)

No endpoint allowlist — the agent needs unrestricted research access (docs, Stack Overflow, npm registries, etc.). Restricting outbound destinations would degrade research quality. Instead, rely on traffic volume anomaly detection and egress proxy logging to catch exfiltration after the fact.

DNS tunneling detection (subdomain length / query volume heuristics) was evaluated and removed — too spotty to be reliable, a determined attacker would trivially bypass the thresholds. Better to invest in egress proxy with TLS inspection (future).

**Detection:** AWS-native — VPC Flow Logs, DNS query logging, CloudWatch metric filters. Architecture should be cloud-agnostic via an adapter — AWS is first implementation, but GCP (VPC Flow Logs equivalent) and Azure (NSG Flow Logs) will need their own adapters.

**Response:** Volume anomaly → medium (flag + Slack alert). For true prevention (not just detection), the long-term approach is an egress proxy that blocks uploads above a size threshold before the connection completes — killing a sandbox after exfiltration already happened is pointless.

### 3. Secrets & Credential Leakage

Prevent API keys, tokens, passwords, and connection strings from appearing in generated code, logs, or PRs.

**Checks:**

- Generated code — scan for hardcoded secrets post-phase (output gate)
- Agent stdout/stderr — scan for accidentally logged secrets post-phase (output gate)
- PR diff — final secrets scan on the full diff before pushing to GitHub (pre-push gate)
- Prompt content — detect secrets from environment variables leaking into prompts (pre-phase input gate)

**Detection:** Arthur Engine PII Detection (Presidio) + custom regex rules for secret patterns (AWS access keys, GitHub tokens, JWTs, database connection strings, private keys).

**Response:** Critical — no PR created, sandbox killed, Slack alert with redacted details.

### 4. PII & Sensitive Business Data

Detect personally identifiable information and confidential business data in inputs and outputs.

**Checks:**

- Jira ticket content — flag customer PII that shouldn't reach the LLM (pre-phase input gate)
- LLM responses — detect PII or confidential business logic in outputs (post-phase output gate)
- Generated code — detect hardcoded customer data, internal URLs, internal IPs (post-phase output gate)

**Detection:** Arthur Engine PII Detection (Presidio) for standard PII (names, emails, SSNs, credit cards). Arthur Engine Sensitive Data evaluation (few-shot LLM Judge) for business-specific confidential data — requires custom examples defining what "sensitive" means for the organization.

**Response:** Critical PII (SSN, credit card) → high (block PR, Slack alert). Other PII/sensitive data → medium (PR with `security-review` label + comment, Slack notification).

### 5. Behavioral Anomalies

Detect unusual agent behavior that may indicate compromise or malfunction.

**Checks:**

- Tool usage patterns — unusual number of WebFetch calls, unexpected tool sequences (CloudWatch logs)
- Execution duration — agent running significantly longer than expected (poll loop)
- Output size anomalies — unusually large or small output for the task type (post-phase)
- Retry storms — same ticket failing repeatedly with different errors (cross-run, Redis registry)
- Token usage spikes — cost per phase significantly above baseline (usage extraction)

**Detection:** Custom Nitro-side logic — threshold-based alerts on CloudWatch metrics and workflow metadata.

**Initial thresholds (static, tuned from first month of production data):**

| Metric | Threshold | Baseline assumption |
|---|---|---|
| WebFetch calls per phase | >30 | Typical research phase: 5-15 fetches |
| Phase execution duration | >20 min (research), >30 min (implementation) | Median: ~8 min research, ~15 min implementation |
| Output size | >500KB or <100 bytes | Typical: 1-50KB |
| Retry count per ticket | >3 within 24h | Most tickets succeed in 1-2 attempts |
| Token usage per phase | >200k tokens | Median: ~50-80k tokens |

Thresholds are static at launch. After 30 days of production data, revisit and consider adaptive baselines derived from rolling 7-day percentiles (p95).

**Response:** Token budget exceeded → critical (kill sandbox — circuit breaker for the infinite loop P0 bug that burned 100M+ tokens). Token usage must have a hard ceiling per phase, not a soft alert. All other anomalies → low (log only, included in Slack usage report).

## Pipeline Integration

Checks hook into the existing workflow pipeline at four gates:

```
Jira Ticket Discovered
    |
    v
+-----------------------------+
| INPUT GATE                  |
| - Prompt injection scan     |
| - PII detection             |
| - Secrets in ticket content |
+-------------+---------------+
              | pass
              v
+-----------------------------+
| RESEARCH PHASE (Fargate)    |
|                             |
| Runtime monitoring:         |
| - VPC Flow Logs (network)   |
| - CloudWatch (tool usage)   |
|                             |
| WebFetch interception:      |
| - Scan fetched content for  |
|   prompt injection before   |
|   it enters LLM context     |
+-------------+---------------+
              |
              v
+-----------------------------+
| OUTPUT GATE (post-research) |
| - Secrets scan              |
| - PII scan                  |
| - Behavioral anomaly check  |
+-------------+---------------+
              | pass
              v
+-----------------------------+
| IMPLEMENTATION PHASE        |
| (same runtime monitoring)   |
+-------------+---------------+
              |
              v
+-----------------------------+
| OUTPUT GATE (post-impl)     |
| - All output checks         |
| - Secrets in generated code |
+-------------+---------------+
              | pass
              v
+-----------------------------+
| REVIEW PHASE (Fargate)      |
| (same runtime monitoring)   |
|                             |
| Input: git diff (untrusted  |
| if impl phase compromised)  |
+-------------+---------------+
              |
              v
+-----------------------------+
| OUTPUT GATE (post-review)   |
| - Secrets scan              |
| - PII scan                  |
| - Behavioral anomaly check  |
+-------------+---------------+
              | pass
              v
+-----------------------------+
| PRE-PUSH GATE               |
| - Final secrets scan on     |
|   full PR diff              |
| - Final PII check           |
+-------------+---------------+
              | pass
              v
        Push to GitHub
        Create PR (with any soft-flag labels)
```

**Codebase integration points:**

- Input gate — in `agentWorkflow` before `writeAndStartPhase`
- WebFetch interception — hook/proxy inside the agent container
- Runtime monitoring — cloud-native (VPC Flow Logs, CloudWatch or equivalent)
- Output gate — in `collectPhaseOutput` before returning results
- Pre-push gate — in `pushFromSandbox` before the git push
- Fix-and-retry path — `fixAndRetryPush` in `poll-agent.ts` spawns a lightweight Claude agent to fix push failures. This agent receives untrusted input (the push error) and runs with `--dangerously-skip-permissions`. Its output must pass through the output gate and pre-push gate before the retry push proceeds.

## Response Model

Four severity tiers with escalation:

| Severity | Triggers | Action |
| -------- | -------- | ------ |
| Critical | Prompt injection detected, secrets in output, data exfiltration (volume anomaly), token budget exceeded | Kill sandbox, cancel workflow, Slack alert |
| High | PII in generated code (SSN, credit card), sensitive business data leak | Block PR creation, Slack alert |
| Medium | PII in inputs (Jira ticket), elevated token spend, unusual tool usage patterns | Create PR with `security-review` label + comment, Slack notification |
| Low | Minor behavioral anomalies (long duration, unusual output size) | Log only, included in Slack usage report |

**Escalation rule:** If the same ticket triggers 2+ medium findings across phases, auto-escalate to high (block PR).

## Observability Streams

Three independent streams unified by Slack alerting:

| Stream | Tool | Scope |
| ------ | ---- | ----- |
| Content analysis | Arthur Engine (adapter-based — Arthur is first impl, others possible) | Prompts, responses, generated code — prompt injection, PII, secrets |
| Network monitoring | Cloud-native (AWS: VPC Flow Logs + CloudWatch; GCP/Azure: equivalent) | Outbound connections, traffic volume, egress anomalies |
| Behavioral analysis | Custom Nitro logic | Tool usage patterns, execution duration, output size, retry storms, token budget enforcement |

## WebFetch Strategy

No domain allowlist. The agent can fetch any URL during research. All fetched content is scanned for prompt injection patterns by Arthur Engine before it enters the LLM context. If injection is detected, the sandbox is killed (critical severity).

Rationale: a strict allowlist would break the research phase since the agent needs to read arbitrary documentation, Stack Overflow, npm registries, etc.

## Debug Mode

On-demand deep inspection mode for investigating suspicious agent behavior or post-incident analysis. Not always-on — toggled per ticket or per workflow run to avoid performance/cost overhead.

**Activation:** Set `DEBUG_MODE=true` as an env override on the ECS RunTask call. Can be triggered:

- Manually — operator flags a ticket ID for debug mode via Slack command or API call
- Automatically — when a medium+ severity finding triggers, the next retry (if any) runs in debug mode

**What debug mode enables:**

| Capability | What it captures | How |
|---|---|---|
| Full prompt logging | Complete prompts sent to Claude, including system prompt, ticket context, and all tool results | Capture stdin of the `claude --print` command |
| Full response logging | Complete LLM responses, including reasoning and tool calls | Already captured via stdout — debug mode preserves the raw unredacted output |
| Tool call trace | Every tool invocation (WebFetch URLs, file reads, file writes, bash commands) with timestamps | Parse Claude Code JSON output for tool-use events |
| Network packet capture | Full TCP payload logging for all outbound connections from the container | Run `tcpdump` as a sidecar process in the Fargate task, write pcap to EFS |
| File system diff | Snapshot of all file changes at each tool call, not just the final diff | Git commit after each tool call via Claude Code end-hook, inspect the commit log post-run |
| Environment dump | All non-secret env vars visible to the agent at startup | Log at container entry point, before claude starts |

**Data retention:** Debug artifacts are written to `/workspace/$RUN_ID/.debug/` on EFS. Retained for 7 days (configurable via `DEBUG_RETENTION_DAYS`), then cleaned up by the daily EFS sweep.

**Access control:** Debug output may contain sensitive data (full prompts, network payloads). Access restricted to operators with security review permissions. Debug artifacts are never included in Slack notifications — only a link to the EFS path.

**Performance impact:** Network packet capture and per-tool-call git commits add overhead. Expected ~10-20% increase in phase duration. This is acceptable since debug mode is not always-on.
