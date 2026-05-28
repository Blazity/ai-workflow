export type NodeType =
  | "trigger"
  | "fetch"
  | "llm"
  | "guard"
  | "tool"
  | "branch"
  | "human"
  | "check"
  | "notify"
  | "output";

export type NodeRunStatus = "ok" | "warn" | "fail" | "pending";

export type FlowParamValue = string | number | boolean | string[];

export interface FlowNodeDef {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
  ports?: number;
  portLabels?: string[];
  params: Record<string, FlowParamValue>;
}

export interface FlowEdgeDef {
  from: string;
  to: string;
  fromPort?: number;
  label?: string;
  dashed?: boolean;
}

export interface Flow {
  id: string;
  name: string;
  workflow: string;
  description: string;
  lastDeployed: string;
  lastDeployedBy: string;
  version: number;
  nodes: FlowNodeDef[];
  edges: FlowEdgeDef[];
}

export type RunStatusMap = Record<string, NodeRunStatus>;

export const PRESANDBOX_FLOW: Flow = {
  id: "presandbox",
  name: "Pre-sandbox steps",
  workflow: "wf_pr_review",
  description:
    "Validation, context-gathering, and planning that runs before the agent's sandbox executes. Output feeds the sandbox runner.",
  lastDeployed: "12m ago",
  lastDeployedBy: "sara.k",
  version: 14,
  nodes: [
    { id: "n1", type: "trigger", name: "Linear · issue assigned", x: 30, y: 240, params: { source: "Linear", event: "issue.assigned", filter: "label = ai-workflow AND assignee = ai-bot", debounce: "2s" } },
    { id: "n2", type: "fetch", name: "Fetch ticket", x: 230, y: 240, params: { tool: "linear.getIssue", include: ["body", "comments", "attachments"], timeout: "5s", retries: 2 } },
    { id: "n3", type: "fetch", name: "Fetch repo state", x: 430, y: 140, params: { tool: "github.repos.get", branch: "main", depth: 1, include: ["tree", "CODEOWNERS", "package.json"] } },
    { id: "n4", type: "fetch", name: "Find related PRs", x: 430, y: 340, params: { tool: "github.search.issues", query: "ticket:{{ticket.id}} OR body:{{ticket.title}}", limit: 5 } },
    { id: "n5", type: "guard", name: "Scope check", x: 630, y: 240, params: { evaluator: "arthur.scope_check", maxFiles: 30, maxLOC: 1200, blocklistGlobs: ["infra/**", "secrets/**"] } },
    { id: "n6", type: "llm", name: "Plan changes", x: 830, y: 240, params: { prompt: "p_plan_changes@v12", model: "claude-sonnet-4", temperature: 0.2, maxTokens: 4096, tools: ["read_file", "grep", "list_dir"] } },
    { id: "n7", type: "branch", name: "Plan is unambiguous?", x: 1030, y: 240, ports: 2, portLabels: ["yes", "no"], params: { condition: "plan.clarification_required == false", branchA: "→ continue", branchB: "→ ask user" } },
    { id: "n8", type: "human", name: "Request clarification", x: 1230, y: 360, params: { channel: "Linear comment", template: "clarify_v3", timeout: "12h", fallback: "page on-call", autoSuggest: 3 } },
    { id: "n9", type: "llm", name: "Estimate budget", x: 1230, y: 120, params: { model: "claude-haiku-4-5", returns: "{ tokens, cost_usd, duration_s }", maxCost: 1.5 } },
    { id: "n10", type: "guard", name: "Cost ceiling", x: 1430, y: 120, params: { evaluator: "ops.cost_ceiling", ceiling: 1.5, action: "block", notify: "owner" } },
    { id: "n11", type: "output", name: "→ Sandbox", x: 1630, y: 180, params: { handoff: "sandbox.execute", payload: "plan + budget + repo_snapshot" } },
  ],
  edges: [
    { from: "n1", to: "n2" }, { from: "n2", to: "n3" }, { from: "n2", to: "n4" },
    { from: "n3", to: "n5" }, { from: "n4", to: "n5" }, { from: "n5", to: "n6" },
    { from: "n6", to: "n7" },
    { from: "n7", to: "n9", fromPort: 0, label: "yes" },
    { from: "n7", to: "n8", fromPort: 1, label: "no" },
    { from: "n9", to: "n10" }, { from: "n10", to: "n11" },
    { from: "n8", to: "n6", dashed: true, label: "retry plan" },
  ],
};

export const POSTPR_FLOW: Flow = {
  id: "postpr",
  name: "Post-PR review steps",
  workflow: "wf_pr_review",
  description:
    "Runs after the agent opens a PR. Triggers GitHub checks, reviews the diff with LLMs, posts statuses, and notifies humans.",
  lastDeployed: "1h ago",
  lastDeployedBy: "marcin.w",
  version: 22,
  nodes: [
    { id: "n1", type: "trigger", name: "PR opened by ai-bot", x: 30, y: 280, params: { source: "GitHub", event: "pull_request.opened", filter: "author = ai-bot", refresh: "on push" } },
    { id: "n2", type: "check", name: "Post check · pending", x: 220, y: 280, params: { check: "ai-review/quality", state: "pending", description: "Reviewing diff…" } },
    { id: "n3", type: "fetch", name: "Fetch PR diff", x: 410, y: 280, params: { tool: "github.pulls.get", include: ["diff", "files", "commits"], maxDiffKb: 512 } },
    { id: "n4", type: "tool", name: "Lint", x: 600, y: 60, params: { runner: "sandbox.exec", cmd: "pnpm lint --filter=...changed", timeout: "60s" } },
    { id: "n5", type: "tool", name: "Typecheck", x: 600, y: 170, params: { runner: "sandbox.exec", cmd: "pnpm typecheck", timeout: "120s" } },
    { id: "n6", type: "tool", name: "Unit tests", x: 600, y: 280, params: { runner: "sandbox.exec", cmd: "pnpm test --changed", timeout: "180s", coverage: true } },
    { id: "n7", type: "llm", name: "Code review", x: 600, y: 390, params: { prompt: "p_pr_review@v8", model: "claude-sonnet-4", reviewStyle: "blocking,nit,praise", maxComments: 12 } },
    { id: "n8", type: "llm", name: "Security audit", x: 600, y: 500, params: { prompt: "p_security_audit@v3", model: "gpt-4.1", scan: ["secrets", "cve", "sql-injection", "ssrf"], severity: "high" } },
    { id: "n9", type: "guard", name: "Aggregate verdict", x: 820, y: 280, params: { evaluator: "arthur.pr_gate", inputs: ["lint", "types", "tests", "review", "security"], threshold: 0.85 } },
    { id: "n10", type: "branch", name: "All checks pass?", x: 1010, y: 280, ports: 2, portLabels: ["pass", "fail"], params: { condition: "verdict.pass == true && security.critical == 0", branchA: "→ approve", branchB: "→ request changes" } },
    { id: "n11", type: "check", name: "Post check · success", x: 1210, y: 170, params: { check: "ai-review/quality", state: "success", description: "{{verdict.summary}}", requiredForMerge: true } },
    { id: "n12", type: "check", name: "Post check · failure", x: 1210, y: 390, params: { check: "ai-review/quality", state: "failure", description: "{{verdict.blockers.join('; ')}}", blockMerge: true } },
    { id: "n13", type: "notify", name: "Comment on PR", x: 1410, y: 280, params: { tool: "github.pulls.createReview", template: "review_summary_v6", inline: "review.comments" } },
    { id: "n14", type: "notify", name: "Update Linear", x: 1610, y: 170, params: { tool: "linear.commentCreate", template: "pr_ready_v2", transition: "In review" } },
    { id: "n15", type: "notify", name: "Slack · #ai-workflow", x: 1610, y: 390, params: { channel: "#ai-workflow", template: "pr_review_done", mention: "@reviewers" } },
  ],
  edges: [
    { from: "n1", to: "n2" }, { from: "n2", to: "n3" },
    { from: "n3", to: "n4" }, { from: "n3", to: "n5" }, { from: "n3", to: "n6" },
    { from: "n3", to: "n7" }, { from: "n3", to: "n8" },
    { from: "n4", to: "n9" }, { from: "n5", to: "n9" }, { from: "n6", to: "n9" },
    { from: "n7", to: "n9" }, { from: "n8", to: "n9" },
    { from: "n9", to: "n10" },
    { from: "n10", to: "n11", fromPort: 0, label: "pass" },
    { from: "n10", to: "n12", fromPort: 1, label: "fail" },
    { from: "n11", to: "n13" }, { from: "n12", to: "n13" },
    { from: "n13", to: "n14" }, { from: "n13", to: "n15" },
  ],
};

export const PRESANDBOX_RUN_STATUS: RunStatusMap = {
  n1: "ok", n2: "ok", n3: "ok", n4: "ok", n5: "ok",
  n6: "ok", n7: "ok", n8: "warn", n9: "ok", n10: "ok", n11: "pending",
};

export const POSTPR_RUN_STATUS: RunStatusMap = {
  n1: "ok", n2: "ok", n3: "ok", n4: "ok", n5: "ok", n6: "ok",
  n7: "ok", n8: "warn", n9: "ok", n10: "ok", n11: "ok", n12: "pending",
  n13: "ok", n14: "ok", n15: "ok",
};
