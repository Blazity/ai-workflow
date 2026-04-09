# Security Observability Spec

Security observability for the AI workflow system (AWS on-prem). Monitors LLM behavior using Arthur Engine for content analysis, AWS-native tooling for network monitoring, and custom Nitro logic for behavioral anomalies.

Target deployment: AWS on-prem architecture (Fargate agents, EC2 Nitro server).

## Threat Categories

### 1. Prompt Injection

Detect adversarial instructions injected into the LLM context from untrusted sources.

**Vectors:**

- Jira ticket descriptions and comments — scanned before they become part of the prompt (pre-phase input gate)
- WebFetch responses — every fetched web page scanned for injection patterns before entering LLM context (during agent execution)
- PR review comments — scanned before the review-fix cycle begins (pre-phase input gate)

**Detection:** Arthur Engine Prompt Injection evaluation (DeBERTa v3 classifier).

**Response:** Critical — kill sandbox, cancel workflow, move ticket to "Security Review" Jira column, Slack alert.

### 2. Data Exfiltration & Network Monitoring

Detect unauthorized outbound communication from agent sandboxes. The primary fear: a prompt-injected agent exfiltrating source code or secrets to an attacker-controlled server.

**Checks:**

- Outbound connections — every TCP connection from Fargate agents via VPC Flow Logs on `sg-fargate`
- DNS queries — domain names the agent resolves via VPC DNS query logging
- Traffic volume — bytes uploaded per connection via VPC Flow Logs aggregation
- Unauthorized endpoints — connections to IPs/domains outside GitHub + Anthropic API
- Large uploads — unusual outbound data volume (e.g., >10MB to a single IP)

**Detection:** AWS-native — VPC Flow Logs, DNS query logging, CloudWatch metric filters.

**Response:** Unauthorized endpoint → critical (kill sandbox). Volume anomaly → medium (flag + alert).

### 3. Secrets & Credential Leakage

Prevent API keys, tokens, passwords, and connection strings from appearing in generated code, logs, or PRs.

**Checks:**

- Generated code — scan for hardcoded secrets post-phase (output gate)
- Agent stdout/stderr — scan for accidentally logged secrets post-phase (output gate)
- PR diff — final secrets scan on the full diff before pushing to GitHub (pre-push gate)
- Prompt content — detect secrets from environment variables leaking into prompts (pre-phase input gate)

**Detection:** Arthur Engine PII Detection (Presidio) + custom regex rules for secret patterns (AWS access keys, GitHub tokens, JWTs, database connection strings, private keys).

**Response:** Critical — no PR created, sandbox killed, ticket to "Security Review", Slack alert with redacted details.

### 4. PII & Sensitive Business Data

Detect personally identifiable information and confidential business data in inputs and outputs.

**Checks:**

- Jira ticket content — flag customer PII that shouldn't reach the LLM (pre-phase input gate)
- LLM responses — detect PII or confidential business logic in outputs (post-phase output gate)
- Generated code — detect hardcoded customer data, internal URLs, internal IPs (post-phase output gate)

**Detection:** Arthur Engine PII Detection (Presidio) for standard PII (names, emails, SSNs, credit cards). Arthur Engine Sensitive Data evaluation (few-shot LLM Judge) for business-specific confidential data — requires custom examples defining what "sensitive" means for the organization.

**Response:** Critical PII (SSN, credit card) → high (block PR). Other PII/sensitive data → medium (PR with `security-review` label + comment).

### 5. Code Safety & Vulnerability Detection

Detect common security vulnerabilities in LLM-generated code.

**Checks:**

- SQL injection patterns in generated database queries
- Command injection via shell commands, exec calls
- XSS vulnerabilities from unsanitized user input rendering
- Insecure dependencies — newly added packages with known CVEs
- Hardcoded secrets (overlaps with threat 3)

**Detection:** Arthur Engine custom rules (keyword + regex) for OWASP Top 10 patterns. Potential future integration with a dedicated SAST tool for deeper analysis.

**Response:** Medium — PR created with `security-review` label + comment describing the specific vulnerability.

### 6. Behavioral Anomalies

Detect unusual agent behavior that may indicate compromise or malfunction.

**Checks:**

- Tool usage patterns — unusual number of WebFetch calls, unexpected tool sequences (CloudWatch logs)
- Execution duration — agent running significantly longer than expected (poll loop)
- Output size anomalies — unusually large or small output for the task type (post-phase)
- Retry storms — same ticket failing repeatedly with different errors (cross-run, Redis registry)
- Token usage spikes — cost per phase significantly above baseline (usage extraction)

**Detection:** Custom Nitro-side logic — threshold-based alerts on CloudWatch metrics and workflow metadata.

**Response:** Low — log only, included in Slack usage report.

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
| - DNS query logging         |
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
| - Code safety (OWASP)       |
| - Secrets in generated code |
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
- Runtime monitoring — AWS-native (VPC Flow Logs, DNS logs, CloudWatch)
- Output gate — in `collectPhaseOutput` before returning results
- Pre-push gate — in `pushChanges` before GitHub API calls

## Response Model

Four severity tiers with escalation:

| Severity | Triggers | Action |
|----------|----------|--------|
| Critical | Prompt injection detected, secrets in output, unauthorized network connection, data exfiltration | Kill sandbox, cancel workflow, move ticket to "Security Review" column, Slack alert |
| High | PII in generated code (SSN, credit card), OWASP vulnerability patterns, sensitive business data leak | Block PR creation, move ticket to "Security Review", Slack alert |
| Medium | PII in inputs (Jira ticket), mild anomalies in tool usage, elevated token spend | Create PR with `security-review` label + comment describing the finding, Slack notification |
| Low | Minor behavioral anomalies (long duration, unusual output size) | Log only, included in Slack usage report |

**Escalation rule:** If the same ticket triggers 2+ medium findings across phases, auto-escalate to high (block PR).

## Observability Streams

Three independent streams unified by Slack alerting:

| Stream | Tool | Scope |
|--------|------|-------|
| Content analysis | Arthur Engine | Prompts, responses, generated code — prompt injection, PII, secrets, toxicity, code safety |
| Network monitoring | AWS (VPC Flow Logs, DNS query logging, CloudWatch) | Outbound connections, DNS resolution, traffic volume, unauthorized endpoints |
| Behavioral analysis | Custom Nitro logic | Tool usage patterns, execution duration, output size, retry storms, token usage |

## WebFetch Strategy

No domain allowlist. The agent can fetch any URL during research. All fetched content is scanned for prompt injection patterns by Arthur Engine before it enters the LLM context. If injection is detected, the sandbox is killed (critical severity).

Rationale: a strict allowlist would break the research phase since the agent needs to read arbitrary documentation, Stack Overflow, npm registries, etc.
