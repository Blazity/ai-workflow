/**
 * A worker that serves agent briefings and clarification rounds from fixed
 * data, for the dashboard's tests and for looking at the screens in a browser
 * before the worker routes exist (`pnpm run fixture-worker`).
 *
 * Nothing here imitates the package: every record is BUILT by the frozen
 * `@shared/agent-visibility` (`buildAgentBriefing`, `explainMissingBriefing`,
 * `assembleClarificationRounds`) and SERVED by its pagers (`pageList`,
 * `pageSectionText`), exactly as the worker's read model will. The inputs are
 * written by hand in the shapes the prompt composer produces (stage 2's parts
 * and origins).
 *
 * Two runs of ticket AWP-235:
 * - `wrun_fx_planning`: a planning attempt that discovers, then plans three
 *   passes (the later two carry the refusal and expansion-closed notes), and an
 *   implementation attempt that failed before its prompt went out.
 * - `wrun_fx_states`: one block per way a briefing can be missing, a send
 *   written by a newer worker, and a cause this dashboard has no words for.
 * - `wrun_fx_expired`: a run whose replay, and briefings, expired.
 */
import {
  AGENT_VISIBILITY_SCHEMA_VERSION,
  AgentVisibilityPageError,
  agentBriefingOverview,
  agentBriefingSectionHeader,
  assembleClarificationRounds,
  buildAgentBriefing,
  clarificationRoundHeader,
  explainMissingBriefing,
  pageList,
  pageSectionText,
  type AgentBriefingBuildInput,
  type AgentBriefingIndex,
  type ClarificationRound,
  type ClarificationRoundRows,
  type MissingBriefingFacts,
  type MissingBriefingReason,
  type VisibilitySanitizer,
} from "@shared/agent-visibility";
import type {
  LiveRunsResponse,
  RunDetailResponse,
  TicketRunsResponse,
  WorkScopeEntry,
  WorkScopeRecordResponse,
  WorkflowReplayAttemptDetail,
  WorkflowReplayAttemptSummary,
  WorkflowReplayGraphNode,
  WorkflowRunReplayResponse,
} from "@shared/contracts";

export const FIXTURE_TICKET = "AWP-235";
export const FIXTURE_SUBJECT = `ticket:jira:${FIXTURE_TICKET}`;
export const PLANNING_RUN = "wrun_fx_planning";
export const STATES_RUN = "wrun_fx_states";
export const EXPIRED_RUN = "wrun_fx_expired";
/** A run whose replay is still here, from before briefings were recorded. */
export const OLD_RUN = "wrun_fx_old";

/** The workflow whose blocks the flow editor asks about. */
export const FIXTURE_DEFINITION = 7;

/**
 * The blocks of that workflow, as the editor shows them: what the worker reads
 * out of the draft (else the deployed version) to answer "what does THIS block
 * send". A node here that no run touched has never run; a node no run and no
 * definition has is simply not a block.
 */
const FIXTURE_DEFINITION_NODES: readonly { nodeId: string; blockType: string }[] = [
  { nodeId: "trigger", blockType: "trigger_ticket_ai" },
  { nodeId: "planning", blockType: "planning_agent" },
  { nodeId: "implementation", blockType: "implementation_agent" },
  { nodeId: "research", blockType: "call_llm" },
  { nodeId: "fix", blockType: "fix_agent" },
  { nodeId: "cleanup", blockType: "generic_agent" },
];

/** Blocks that put a prompt in front of a model, as the worker decides it
 *  (`PROMPT_SENDING_BLOCK_TYPES`, apps/worker/src/services/agent-visibility). */
const PROMPT_SENDING = new Set([
  "planning_agent",
  "implementation_agent",
  "review_agent",
  "fix_agent",
  "generic_agent",
  "prepare_workspace",
  "call_llm",
  "investigate",
]);

export const SHOP_WEB = "github:acme/shop-web";
export const SHOP_API = "github:acme/shop-api";
export const LEGACY = "github:acme/legacy-checkout";
export const OLD_ADMIN = "github:acme/old-admin";
/** Offered in the first question, named in its words, and never decided about:
 *  the repository somebody may have meant and nobody recorded. */
export const SHOP_MOBILE = "github:acme/shop-mobile";

export const SECRET = "sk-live-4f9Qm2Lx8Rt7Zp";
export const FILIP = "Filip Maszota";
export const ANNA = "Anna Kowalska";

/** Reports every `sk-live-` token and every e-mail address, by UTF-16
 *  position, the way the worker's detector reports what it finds. */
export const fixtureSanitizer: VisibilitySanitizer = (text) => {
  const found: { start: number; end: number; kind: string }[] = [];
  for (const [pattern, kind] of [
    [/sk-live-[A-Za-z0-9]+/g, "token"],
    [/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/g, "email"],
  ] as const) {
    for (const match of text.matchAll(pattern)) {
      found.push({ start: match.index, end: match.index + match[0].length, kind });
    }
  }
  return found.sort((left, right) => left.start - right.start);
};

/* ── The planning attempt ──────────────────────────────────────────────── */

type Part = NonNullable<AgentBriefingBuildInput["sections"][number]["parts"]>[number];

const part = (id: string, title: string, origin: Part["origin"], content: string, extra: Partial<Part> = {}): Part => ({
  id,
  title,
  origin,
  content,
  ...extra,
});

/** Long enough to cross the 48 KB page: a ticket someone pasted a log into,
 *  with an emoji every line and a secret and an address in the middle. */
function longDescription(): string {
  const lines: string[] = [];
  for (let line = 1; line <= 620; line += 1) {
    lines.push(
      `${String(line).padStart(4, "0")} 📱 checkout tap ignored: koszyk nie działa, zażółć gęślą jaźń; handler=onCheckoutPress state=idle`,
    );
    if (line === 300) lines.push(`Staging key pasted by mistake: ${SECRET}. Contact: anna.kowalska@acme.dev`);
  }
  return lines.join("\n");
}

const REPOSITORY_ACCESS_PROTOCOL = `

## Repository Access Protocol

This protocol extends and overrides any older Output Format instructions above.

- Inspect only repositories already attached to the workspace.
- If an additional repository is required, return \`status: "repositories_needed"\`
  with at most 3 exact provider/repoPath identities and a rationale for each.
- Research is read-only: do not modify files, create commits, or change branches.
`;

const MAP_TEXT = `
## Selected Repositories

- ${SHOP_WEB} (write): The storefront: the Next.js app for web and mobile web. Owns checkout UI, cart and product pages.
  - is a frontend for ${SHOP_API}
  - Rules: Never change payment provider configuration.
- ${SHOP_API} (read only, related: ${SHOP_WEB} is a frontend for it): Shop API
- ${LEGACY} (excluded, do not request): Excluded by ${FILIP} on this ticket: not part of this work.
- ${OLD_ADMIN} (disabled, do not request): Disabled in the catalog by an administrator.
- And 12 more repositories in the catalog: ask by name.
`;

function runtimeParts(pass: 1 | 2 | 3): Part[] {
  const parts: Part[] = [
    part("ticket", "Ticket", { kind: "ticket", ref: FIXTURE_TICKET },
      `# Requirements\n\n## Ticket ID\n\n${FIXTURE_TICKET}\n\n## Ticket\n\nCheckout button does nothing on mobile\n`),
    part("description", "Ticket description", { kind: "ticket", ref: FIXTURE_TICKET },
      `\n## Description\n\n${longDescription()}\n\n`),
    part("acceptance-criteria", "Acceptance criteria", { kind: "ticket", ref: FIXTURE_TICKET },
      "## Acceptance Criteria\n\nTapping Checkout on iOS Safari opens the payment step.\n\n"),
    part("comments", "Ticket comments", { kind: "ticket", ref: FIXTURE_TICKET }, "## Comments\n\n"),
    part("comment:1", "Ticket comment 1", { kind: "ticket_comment", ref: FIXTURE_TICKET, label: FILIP },
      `${FILIP}: it started after the last deploy, only on iOS 18.\n\n`),
    part("comment:2", "Ticket comment 2", { kind: "ticket_comment", ref: FIXTURE_TICKET, label: ANNA },
      `${ANNA}: reproduced on Safari; the button renders but the click handler never fires.\n`),
    part("clarifications", "Clarification answers", { kind: "clarification" }, "\n## Clarification answers\n\n"),
    part("clarification:1", "Clarification round 1", { kind: "clarification", ref: "1", label: FILIP }, "", {
      cut: { originalLengthUtf16: 18_400, cause: "clarification_budget" },
    }),
    part("clarification:2", "Clarification round 2", { kind: "clarification", ref: "2", label: FILIP },
      `Q: Which repository should ${FIXTURE_TICKET} change?\nA: ${SHOP_WEB}\n`),
    part("branch", "Branch", { kind: "run" }, "\n## Branch\n\nai/awp-235-checkout-mobile\n"),
    part("selected-repositories", "Selected repositories", { kind: "workspace" }, MAP_TEXT),
    part("pr-comments", "Pull request comments", { kind: "pull_request", ref: SHOP_WEB },
      "\n## PR Review Feedback\n\n- src/checkout/Button.tsx:42 (Anna Kowalska): the touchstart listener is passive, so preventDefault never runs.\n"),
    part("vendor-hint", "Hint from the harness vendor", { kind: "vendor_hint", ref: "hint-7" },
      "\nPrefer small, reviewable commits.\n"),
  ];
  if (pass >= 2) {
    parts.push(
      part("refused-requests", "Repository requests this run refused", { kind: "research_note" },
        "\n## Repository requests this run refused\n\n"),
      part("refusal:1", "Refused request 1", { kind: "research_note", ref: LEGACY },
        `${LEGACY} was refused: a person excluded it from this work (${FILIP}, 18 Sep).\n`),
      part("refused-requests-guidance", "What to do instead of asking again", { kind: "platform" },
        "Requesting these again changes nothing. Plan with the repositories already attached.\n"),
    );
  }
  if (pass === 3) {
    parts.push(
      part("expansion-closed", "Repository expansion closed", { kind: "research_note" },
        "\n## Repository expansion closed\n\nNo further repository will be attached to this workspace: "),
      part("expansion-closed-guidance", "What to do now that expansion is closed", { kind: "platform" },
        "requesting one again changes nothing, and repeating the request ends the run.\n"),
      part("ci-checks", "CI/CD check results", { kind: "pull_request", ref: SHOP_WEB },
        `\n## CI/CD Check Results\n\n${"e2e/checkout.spec.ts: timeout waiting for [data-test=checkout]\n".repeat(40)}`,
        { cut: { originalLengthUtf16: 212_000, cause: "section_cap" } }),
      part("block-prompt", "Block prompt", { kind: "block_prompt" }, "", {
        cut: { originalLengthUtf16: 640, cause: "section_cap" },
      }),
      part("repository-access-protocol", "Repository Access Protocol", { kind: "platform", ref: "repository-access-protocol" }, "", {
        cut: { originalLengthUtf16: REPOSITORY_ACCESS_PROTOCOL.length, cause: "section_cap" },
      }),
    );
    return parts;
  }
  parts.push(
    part("block-prompt", "Block prompt", { kind: "block_prompt" }, "\n---\n\nPlan the smallest change that makes Checkout work on iOS.\n"),
    part("repository-access-protocol", "Repository Access Protocol", { kind: "platform", ref: "repository-access-protocol" },
      REPOSITORY_ACCESS_PROTOCOL),
    {
      id: "resolution-check",
      title: "Resolution Check",
      origin: { kind: "platform", ref: "resolution-check" },
      content: "",
      withheld: {
        reason: "pr_feedback_present",
        text: "The pull request carries review feedback, which is the task, so the already-resolved exit is not offered.",
      },
    },
  );
  return parts;
}

const decidedByFilip = { kind: "person" as const, actorId: "usr_filip", actorLabel: FILIP };

const WORK_SCOPE_ENTRIES: WorkScopeEntry[] = [
  {
    repositoryKey: SHOP_WEB,
    state: "selected",
    origin: "person",
    rationale: "named in the answer to question 1",
    decidedBy: decidedByFilip,
    decidedAt: "2026-09-18T09:20:04.000Z",
  },
  {
    repositoryKey: SHOP_API,
    state: "selected",
    origin: "person",
    rationale: "named in an answer before this ticket's rewrite",
    decidedBy: { kind: "person", actorId: "usr_anna", actorLabel: ANNA },
    decidedAt: "2026-09-10T08:14:00.000Z",
  },
  {
    repositoryKey: LEGACY,
    state: "excluded",
    origin: "person",
    rationale: "not part of this work",
    decidedBy: decidedByFilip,
    decidedAt: "2026-09-18T10:02:10.000Z",
  },
  {
    repositoryKey: OLD_ADMIN,
    state: "unavailable",
    unavailableReason: "not_enabled",
    origin: "trigger_policy",
    rationale: "requested by the agent and not enabled in the catalog",
    decidedBy: { kind: "run", runId: PLANNING_RUN, definitionId: 40, definitionVersion: 12 },
    decidedAt: "2026-09-18T09:02:00.000Z",
  },
];

function repositoryContext(): NonNullable<AgentBriefingBuildInput["repositoryContext"]> {
  return {
    repositories: [
      {
        key: SHOP_WEB,
        description: {
          source: "catalog",
          text: "The storefront: the Next.js app for web and mobile web. Owns checkout UI, cart and product pages.",
        },
        rules: "Never change payment provider configuration. Run pnpm test before opening a pull request.",
        relationships: [{ kind: "frontend_for", target: SHOP_API, note: "REST, /v2" }],
        state: "write",
        inclusion: { cause: "named" },
        rendering: "full",
        workScopeEntry: WORK_SCOPE_ENTRIES[0]!,
      },
      {
        key: SHOP_API,
        description: { source: "provider", text: "Shop API" },
        rules: null,
        relationships: [],
        state: "read_only",
        inclusion: { cause: "related", via: { key: SHOP_WEB, relationship: "frontend_for" } },
        rendering: "full",
        workScopeEntry: WORK_SCOPE_ENTRIES[1]!,
      },
      {
        key: LEGACY,
        description: { source: "catalog", text: "The checkout before the 2025 rewrite. Kept for reference." },
        rules: null,
        relationships: [{ kind: "mirror_of", target: SHOP_WEB }],
        state: "excluded",
        reason: `Excluded by ${FILIP} on this ticket: not part of this work.`,
        inclusion: { cause: "work_scope_entry" },
        rendering: "line",
        workScopeEntry: WORK_SCOPE_ENTRIES[2]!,
      },
      {
        key: OLD_ADMIN,
        description: { source: "none", text: "" },
        rules: null,
        relationships: [],
        state: "disabled",
        reason: "Disabled in the catalog by an administrator: do not request it.",
        inclusion: { cause: "catalog" },
        rendering: "line",
        workScopeEntry: null,
      },
      {
        key: "github:acme/payments-sdk",
        description: { source: "provider", text: "Payments SDK" },
        rules: null,
        relationships: [],
        state: "archived",
        inclusion: { cause: "catalog" },
        rendering: "line",
        workScopeEntry: null,
      },
    ],
    unlistedCount: 12,
    workScope: { version: 4, leftOutKeys: [LEGACY] },
    renderedAt: { sectionIndex: 4, partId: "selected-repositories" },
  };
}

const HARNESS: AgentBriefingBuildInput["harness"] = {
  provider: "claude",
  model: "claude-opus-4-1-20250805",
  outputSchema: '{"type":"object","required":["status"]}',
  skills: [{ id: "repository-map-check", version: 2 }],
  profile: { id: "builtin-claude", version: 7 },
  wrapperScript: "#!/bin/sh\nclaude --print --output-format json\n",
  includeWorkflowData: true,
  includeRepositoryInstructions: true,
};

function identity(
  runId: string,
  nodeId: string,
  sequence: number,
  kind: "discovery" | "agent" | "llm",
  blockType: string,
  capturedAt: string,
  passLabel?: string,
): AgentBriefingBuildInput["identity"] {
  return {
    runId,
    nodeId,
    attempt: 1,
    activationScopeId: "root",
    sequence,
    kind,
    blockType,
    capturedAt,
    ...(passLabel ? { passLabel } : {}),
  };
}

function discoveryInput(runId: string, nodeId: string): AgentBriefingBuildInput {
  const parts = [
    part("discovery-instructions", "Instructions", { kind: "platform", ref: "discovery" },
      "Choose the repositories this ticket needs. Answer with their keys and a reason for each.\n\n"),
    part("ticket", "Ticket", { kind: "ticket", ref: FIXTURE_TICKET },
      `Ticket ${FIXTURE_TICKET}: Checkout button does nothing on mobile\n\n`),
    part("catalog", "Catalog", { kind: "repository_catalog" },
      `${SHOP_WEB}: storefront\n${SHOP_API}: Shop API\n${LEGACY}: legacy checkout\n`),
  ];
  return {
    identity: identity(runId, nodeId, 1, "discovery", "planning_agent", "2026-09-18T08:59:40.000Z"),
    harness: { provider: "claude", model: "claude-haiku-4-5", outputSchema: '{"type":"object"}', profile: null, wrapperScript: null },
    sections: [
      {
        kind: "discovery",
        title: "Repository discovery",
        text: parts.map((entry) => entry.content).join(""),
        parts,
      },
    ],
    repositoryContext: {
      repositories: [SHOP_WEB, SHOP_API, LEGACY].map((key) => ({
        key,
        description: { source: "provider", text: key.split("/")[1]! },
        rules: null,
        relationships: [],
        state: "offered",
        inclusion: { cause: "catalog" },
        rendering: "line",
        workScopeEntry: null,
      })),
      unlistedCount: 0,
      workScope: null,
    },
  };
}

function passInput(pass: 1 | 2 | 3): AgentBriefingBuildInput {
  const parts = runtimeParts(pass);
  const agentsMd = `# AGENTS.md for ${SHOP_WEB}\n\n${"Run pnpm test and pnpm lint before a pull request. Components live in src/components.\n".repeat(420)}`;
  return {
    identity: identity(
      PLANNING_RUN,
      "planning",
      pass + 1,
      "agent",
      "planning_agent",
      `2026-09-18T09:${String(25 + pass * 10).padStart(2, "0")}:00.000Z`,
      pass === 2 ? "expansion round 1" : pass === 3 ? "expansion closed" : undefined,
    ),
    harness: HARNESS,
    sections: [
      {
        kind: "profile",
        title: "Harness profile: Claude default",
        provenance: [{ kind: "profile", id: "builtin-claude", version: 7, hash: "f".repeat(64) }],
        text: "Answer in the structured format. Be precise about repository keys.\n",
      },
      {
        kind: "repository",
        title: `${SHOP_WEB} AGENTS.md`,
        provenance: [{ kind: "repository", id: `${SHOP_WEB}:AGENTS.md`, version: null, hash: "a".repeat(64) }],
        text: agentsMd,
      },
      {
        kind: "memory",
        title: `${SHOP_WEB} facts`,
        provenance: [{ kind: "memory", id: `${SHOP_WEB}:facts`, version: null, hash: "b".repeat(64) }],
        text: "Checkout uses a custom Button with a touchstart listener.\n",
      },
      {
        kind: "block",
        title: "Block role and task",
        provenance: [{ kind: "prompt", id: "prm_research:research-plan", version: 3, hash: "c".repeat(64) }],
        text: "You are the planning agent. Read the ticket and the repositories, then plan.\n",
      },
      {
        kind: "runtime",
        title: "Runtime data",
        provenance: [{ kind: "runtime", id: "node:planning", version: null, hash: "d".repeat(64) }],
        text: parts.map((entry) => entry.content).join(""),
        parts,
      },
    ],
    repositoryContext: repositoryContext(),
    unresolvedSources:
      pass === 1
        ? [
            {
              kind: "repository_file",
              reference: `${SHOP_API}/AGENTS.md`,
              message: "Not found: the repository has no AGENTS.md at its root.",
            },
          ]
        : [],
  };
}

function llmInput(nodeId: string): AgentBriefingBuildInput {
  return {
    identity: identity(STATES_RUN, nodeId, 1, "llm", "call_llm", "2026-09-19T08:40:00.000Z"),
    harness: { provider: "claude", model: "claude-haiku-4-5", outputSchema: null, profile: null, wrapperScript: null },
    sections: [
      { kind: "system", title: "System prompt", text: "You summarize tickets for a release note." },
      { kind: "block", title: "Prompt", text: `Summarize ${FIXTURE_TICKET} in one sentence.` },
    ],
    repositoryContext: null,
  };
}

/* ── Attempts, the replay, and why briefings are missing ───────────────── */

interface FixtureAttempt {
  summary: WorkflowReplayAttemptSummary;
  /** Null past the replay's life: the definition snapshot that would answer
   *  it is gone, and the worker says so rather than guessing from today. */
  sendsPrompts: boolean | null;
  /** Which turn of which loop this attempt ran in, as the worker reads it off
   *  the activation scope (`root/loop:<node>:<index>`). */
  iteration?: { loopNodeId: string; index: number };
  briefingIds: string[];
  missing: MissingBriefingReason | null;
}

interface FixtureRun {
  runId: string;
  status: "failed" | "awaiting" | "success";
  /** The workflow version this run executed, which is not always the one being
   *  edited: the newest run of a block wins whatever version it ran. */
  definitionVersion: number;
  /** What capture did with this run's sends, as the worker counts them beside
   *  the run state. Null where nothing capture-capable ever recorded for it. */
  capture: {
    captured: number;
    disabled: number;
    skipped: number;
    failed: number;
    conflict: number;
  } | null;
  nodes: WorkflowReplayGraphNode[];
  attempts: FixtureAttempt[];
  availability: "available" | "expired";
  /** What the run itself can still say about its briefings. */
  briefingsState: "available" | "expired" | "replay_gone" | "predates_capture";
}

const facts = (overrides: Partial<MissingBriefingFacts>): MissingBriefingFacts => ({
  attemptState: "completed",
  runStatus: "failed",
  failure: null,
  promptSent: "unknown",
  captureCapable: true,
  captureDisabled: false,
  capturedKinds: [],
  replayExpired: false,
  ...overrides,
});

let attemptIds = 0;
function summary(
  nodeId: string,
  state: WorkflowReplayAttemptSummary["state"],
  startedAt: string,
  durationMs: number | null,
): WorkflowReplayAttemptSummary {
  attemptIds += 1;
  return {
    id: attemptIds,
    nodeId,
    attempt: 1,
    activationScopeId: "root",
    state,
    outcome:
      state === "failed"
        ? { kind: "failed", status: "execution_failure" }
        : state === "completed"
          ? { kind: "completed", status: "ok" }
          : null,
    selectedTransition: state === "completed" ? { port: "out", edgeIds: [] } : null,
    startedAt,
    completedAt: durationMs === null ? null : new Date(Date.parse(startedAt) + durationMs).toISOString(),
    durationMs,
    diagnosticId: state === "failed" ? "AIW-DIAG-7f3a" : null,
  };
}

const node = (id: string, type: WorkflowReplayGraphNode["type"], name: string, x: number, y: number): WorkflowReplayGraphNode => ({
  id,
  type,
  name,
  x,
  y,
});

/* ── Rounds ────────────────────────────────────────────────────────────── */

const reading = (outcome: Record<string, unknown>, readAt: string, readBy: "model" | "deterministic" = "model") => ({
  version: 1,
  outcome: outcome as { kind: string },
  readBy,
  ...(readBy === "model" ? { model: "claude-haiku-4-5" } : {}),
  readAt,
});

function roundRows(): ClarificationRoundRows {
  const filip = { kind: "person", display: FILIP };
  const repeated = Array.from({ length: 300 }, (_unused, index) => ({
    clarificationId: "clr_2",
    words: "no, leave legacy out",
    author: filip,
    surface: "jira",
    firstAt: new Date(Date.parse("2026-09-18T10:02:00.000Z") + index * 60_000).toISOString(),
    reading: reading({ kind: "declined_one", repositoryKey: LEGACY }, "2026-09-18T10:02:05.000Z"),
    note: `Recorded: ${LEGACY} stays excluded from ${FIXTURE_TICKET}.`,
  }));
  return {
    questions: [
      {
        clarificationId: "clr_1",
        runId: PLANNING_RUN,
        nodeId: "planning",
        questions: [
          `Which repository should ${FIXTURE_TICKET} change? The checkout lives in ${SHOP_WEB}, but the button may call ${SHOP_API}, and the same screen exists in ${SHOP_MOBILE}.`,
        ],
        askedAt: "2026-09-18T09:00:00.000Z",
        status: "cancelled",
        offered: [
          { key: SHOP_WEB, askedBecause: "selection", named: true },
          { key: SHOP_API, askedBecause: "selection", named: true },
          { key: SHOP_MOBILE, askedBecause: "selection", named: true },
        ],
      },
      {
        clarificationId: "clr_1b",
        runId: PLANNING_RUN,
        nodeId: "planning",
        questions: [
          `Which repository should ${FIXTURE_TICKET} change? The checkout lives in ${SHOP_WEB}, but the button may call ${SHOP_API}, and the same screen exists in ${SHOP_MOBILE}.`,
        ],
        askedAt: "2026-09-18T09:01:30.000Z",
        status: "answered",
        offered: [
          { key: SHOP_WEB, askedBecause: "selection", named: true },
          { key: SHOP_API, askedBecause: "selection", named: true },
          { key: SHOP_MOBILE, askedBecause: "selection", named: true },
        ],
      },
      {
        clarificationId: "clr_2",
        runId: PLANNING_RUN,
        nodeId: "planning",
        questions: [`${LEGACY} is excluded on this ticket. Should this run use it after all?`],
        askedAt: "2026-09-18T10:00:00.000Z",
        status: "answered",
        offered: [{ key: LEGACY, askedBecause: "outside_policy", named: true }],
      },
      {
        clarificationId: "clr_3",
        runId: "wrun_before_recording",
        nodeId: "planning",
        questions: ["Which repository holds the payment widget?"],
        askedAt: "2026-09-10T08:00:00.000Z",
        status: "answered",
        offered: [],
      },
      {
        clarificationId: "clr_4",
        runId: STATES_RUN,
        nodeId: "planning",
        questions: [
          "This run holds 11 repositories and may work on 3. Which are essential for AWP-235?",
        ],
        askedAt: "2026-09-19T08:30:00.000Z",
        status: "pending",
        offered: [],
      },
    ],
    deliveries: [
      {
        clarificationId: "clr_1b",
        words: "the web one probably",
        author: filip,
        surface: "jira",
        firstAt: "2026-09-18T09:05:00.000Z",
        reading: reading({ kind: "unclear", paraphrase: `They may mean ${SHOP_WEB}.` }, "2026-09-18T09:05:04.000Z"),
        note: `I could not tell which repository you meant. Did you mean ${SHOP_WEB}? Reply with the repository or "none".`,
      },
      {
        clarificationId: "clr_1b",
        words: "hmm, the frontend?",
        author: filip,
        surface: "jira",
        firstAt: "2026-09-18T09:12:00.000Z",
        reading: reading({ kind: "unclear" }, "2026-09-18T09:12:03.000Z", "deterministic"),
        note: "I still could not tell which repository you meant. Reply with a repository key.",
      },
      ...Array.from({ length: 5 }, (_unused, index) => ({
        clarificationId: "clr_1b",
        words: SHOP_WEB,
        author: filip,
        surface: "jira",
        firstAt: `2026-09-18T09:2${index}:00.000Z`,
        reading: reading({ kind: "repositories", repositoryKeys: [SHOP_WEB] }, "2026-09-18T09:20:04.000Z"),
        note: `Recorded ${SHOP_WEB} for ${FIXTURE_TICKET}. The run continues with it.`,
      })),
      ...repeated,
      // A row the store kept without its words: it cannot be read, and the
      // round says one row is not shown.
      { clarificationId: "clr_2", author: filip, surface: "jira", firstAt: "2026-09-18T15:00:00.000Z", reading: null, note: null } as never,
    ],
    trail: [
      { id: 101, at: "2026-09-18T09:00:00.000Z", event: { kind: "question_asked", clarificationId: "clr_1", repositories: [] } },
      {
        id: 103,
        at: "2026-09-18T09:20:04.000Z",
        event: {
          kind: "question_answered",
          clarificationId: "clr_1b",
          answer: { kind: "repositories", repositoryKeys: [SHOP_WEB] },
          answeredBy: decidedByFilip,
        },
      },
      {
        id: 104,
        at: "2026-09-18T09:20:04.000Z",
        event: { kind: "entry_written", entry: WORK_SCOPE_ENTRIES[0]!, previousState: null, clarificationId: "clr_1b" },
      },
      {
        id: 110,
        at: "2026-09-18T10:02:05.000Z",
        event: {
          kind: "entry_written",
          entry: WORK_SCOPE_ENTRIES[2]!,
          previousState: "excluded",
          clarificationId: "clr_2",
        },
      },
      {
        id: 120,
        at: "2026-09-10T08:14:00.000Z",
        event: {
          kind: "question_answered",
          clarificationId: "clr_3",
          answer: { kind: "repositories", repositoryKeys: [SHOP_API] },
          answeredBy: { kind: "person", actorId: "usr_anna", actorLabel: ANNA },
        },
      },
      {
        id: 130,
        at: "2026-09-19T08:30:00.000Z",
        event: { kind: "question_asked", clarificationId: "clr_4", repositories: [], purpose: "narrowing" },
      },
      {
        id: 131,
        at: "2026-09-19T08:30:01.000Z",
        event: { kind: "map_linked", clarificationId: "clr_4", mapVersion: 3, note: "from a newer worker" },
      },
    ],
  };
}

/* ── The store ─────────────────────────────────────────────────────────── */

export interface FixtureStore {
  runs: Map<string, FixtureRun>;
  briefings: Map<string, AgentBriefingIndex>;
  /** Overviews served as written; one is rewritten to a newer version. */
  overviews: Map<string, unknown>;
  texts: Map<string, string>;
  rounds: ClarificationRound[];
  /** The one record an edit writes to, so a change made on the screen is
   *  there when the screen reads the record again. */
  scope: { version: number; entries: WorkScopeEntry[] };
}

/** The catalog the fixture edit tests a `select` against, as the worker tests
 *  it. `OLD_ADMIN` is deliberately outside it: it is the record's
 *  "Unavailable: not enabled" entry, and selecting it is refused. */
const FIXTURE_ENABLED_KEYS = new Set([SHOP_WEB, SHOP_API, LEGACY, SHOP_MOBILE]);

/** The record as `buildFixtureStore` leaves it. Tests that edit call this
 *  first, because the store is built once for a whole file. */
function initialScope(): FixtureStore["scope"] {
  return { version: 4, entries: structuredClone(WORK_SCOPE_ENTRIES) };
}

export function resetFixtureScope(store: FixtureStore): void {
  store.scope = initialScope();
}

async function record(store: FixtureStore, briefingId: string, input: AgentBriefingBuildInput, budgetBytes?: number) {
  const built = await buildAgentBriefing(input, {
    sanitize: fixtureSanitizer,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
  });
  for (const entry of built.texts) store.texts.set(entry.sha256, entry.text);
  store.briefings.set(briefingId, built.index);
  store.overviews.set(briefingId, agentBriefingOverview(built.index));
  return briefingId;
}

export async function buildFixtureStore(): Promise<FixtureStore> {
  attemptIds = 0;
  const store: FixtureStore = {
    runs: new Map(),
    briefings: new Map(),
    overviews: new Map(),
    texts: new Map(),
    rounds: [],
    scope: initialScope(),
  };

  // The planning run. The storage budget is below what a pass sent, so the
  // AGENTS.md section is kept only in part: trimmed for storage, not for the
  // agent (sections with provenance give way first).
  const planningIds = [
    await record(store, "brf_plan_1", discoveryInput(PLANNING_RUN, "planning")),
    await record(store, "brf_plan_2", passInput(1), 96 * 1024),
    await record(store, "brf_plan_3", passInput(2), 96 * 1024),
    await record(store, "brf_plan_4", passInput(3), 96 * 1024),
  ];
  const implementationFailure = {
    category: "sandbox",
    message: "The sandbox stopped responding while the workspace was prepared.",
    beforeSend: true,
  };
  store.runs.set(PLANNING_RUN, {
    runId: PLANNING_RUN,
    status: "failed",
    definitionVersion: 7,
    capture: { captured: 4, disabled: 0, skipped: 0, failed: 0, conflict: 0 },
    availability: "available",
    briefingsState: "available",
    nodes: [
      node("trigger", "trigger_ticket_ai", "Ticket in AI column", 0, 40),
      node("planning", "planning_agent", "Plan the change", 260, 40),
      node("implementation", "implementation_agent", "Implement", 520, 40),
    ],
    attempts: [
      { summary: summary("trigger", "completed", "2026-09-18T08:59:00.000Z", 120), sendsPrompts: false, briefingIds: [], missing: null },
      { summary: summary("planning", "completed", "2026-09-18T08:59:30.000Z", 2_880_000), sendsPrompts: true, briefingIds: planningIds, missing: null },
      {
        summary: summary("implementation", "failed", "2026-09-18T09:48:00.000Z", 94_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: explainMissingBriefing(facts({ attemptState: "failed", failure: implementationFailure, promptSent: false })),
      },
    ],
  });

  // Every other way a briefing can be missing, one block each.
  const statesDiscovery = await record(store, "brf_states_1", discoveryInput(STATES_RUN, "planning"));
  const statesLlm = await record(store, "brf_states_llm", llmInput("summarize"));
  const newer = await record(store, "brf_states_newer", {
    ...llmInput("research"),
    identity: identity(STATES_RUN, "research", 1, "llm", "call_llm", "2026-09-19T08:41:00.000Z"),
  });
  store.overviews.set(newer, {
    ...(store.overviews.get(newer) as object),
    schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION + 1,
    attention: { kind: "a field this dashboard does not know" },
  });
  const live = facts({ runStatus: "awaiting" });
  store.runs.set(STATES_RUN, {
    runId: STATES_RUN,
    status: "awaiting",
    definitionVersion: 9,
    capture: { captured: 3, disabled: 1, skipped: 2, failed: 1, conflict: 0 },
    availability: "available",
    briefingsState: "available",
    nodes: [
      node("planning", "planning_agent", "Plan (waiting for an answer)", 0, 0),
      node("review", "review_agent", "Review (old code)", 260, 0),
      node("fix", "fix_agent", "Fix (capture off)", 520, 0),
      node("summarize", "call_llm", "Summarize (write lost)", 0, 140),
      node("generic", "generic_agent", "Generic (cancelled)", 260, 140),
      node("investigate", "investigate", "Investigate (expired)", 520, 140),
      node("research", "call_llm", "Research (newer worker)", 0, 280),
      node("mystery", "generic_agent", "Generic (new cause)", 260, 280),
    ],
    attempts: [
      {
        summary: summary("planning", "waiting_for_clarification", "2026-09-19T08:29:00.000Z", 60_000),
        sendsPrompts: true,
        briefingIds: [statesDiscovery],
        missing: explainMissingBriefing({ ...live, attemptState: "waiting_for_clarification", capturedKinds: ["discovery"] }),
      },
      {
        summary: summary("review", "completed", "2026-09-19T08:31:00.000Z", 42_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: explainMissingBriefing({ ...live, captureCapable: false, promptSent: true }),
      },
      {
        summary: summary("fix", "completed", "2026-09-19T08:33:00.000Z", 51_000),
        sendsPrompts: true,
        iteration: { loopNodeId: "fix-loop", index: 3 },
        briefingIds: [],
        missing: explainMissingBriefing({ ...live, captureDisabled: true, promptSent: true }),
      },
      {
        summary: summary("summarize", "completed", "2026-09-19T08:40:00.000Z", 3_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: explainMissingBriefing({ ...live, promptSent: true }),
      },
      {
        summary: summary("generic", "cancelled", "2026-09-19T08:42:00.000Z", 1_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: explainMissingBriefing({ ...live, attemptState: "cancelled" }),
      },
      {
        summary: summary("investigate", "completed", "2026-09-19T08:44:00.000Z", 9_000),
        sendsPrompts: null,
        briefingIds: [],
        missing: explainMissingBriefing({ ...live, replayExpired: true, capturedKinds: ["llm"], promptSent: true }),
      },
      {
        summary: summary("research", "completed", "2026-09-19T08:41:00.000Z", 4_000),
        sendsPrompts: true,
        briefingIds: [newer, statesLlm],
        missing: null,
      },
      {
        summary: summary("mystery", "completed", "2026-09-19T08:46:00.000Z", 2_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: { schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION, kind: "not_recorded", cause: "sampled_out" },
      },
    ],
  });

  // A run old enough to predate briefings, with its replay still in hand: the
  // Block Attempt is there to open, and only the run's own state can say why
  // there is nothing inside it.
  store.runs.set(OLD_RUN, {
    runId: OLD_RUN,
    status: "success",
    definitionVersion: 3,
    capture: null,
    availability: "available",
    briefingsState: "predates_capture",
    nodes: [node("planning", "planning_agent", "Plan the change", 0, 0)],
    attempts: [
      {
        summary: summary("planning", "completed", "2026-08-01T10:00:00.000Z", 640_000),
        sendsPrompts: true,
        briefingIds: [],
        missing: explainMissingBriefing(facts({ runStatus: "success", promptSent: true, capturedKinds: [] })),
      },
    ],
  });

  // A run past its retention: no attempts and no briefings at all, and the
  // state is the only thing that can say we kept them and retention took them.
  store.runs.set(EXPIRED_RUN, {
    runId: EXPIRED_RUN,
    status: "success",
    definitionVersion: 1,
    capture: null,
    availability: "expired",
    briefingsState: "expired",
    nodes: [],
    attempts: [],
  });

  store.rounds = assembleClarificationRounds(roundRows()).rounds;
  return store;
}

/* ── Serving ───────────────────────────────────────────────────────────── */

export interface FixtureResponse {
  status: number;
  body: unknown;
}

const ok = (body: unknown): FixtureResponse => ({ status: 200, body });

/** A row the worker itself could not read: named on the page rather than
 *  dropped, and counted by neither `items` nor `total`. */
interface FixtureUnreadable {
  rows: string;
  position: number;
  id: string | null;
  problem: string;
}

/**
 * A page as the WORKER serves it: the frozen package's page plus the rows it
 * refused. The package pager knows no such key; the worker adds it
 * (`apps/worker/src/services/agent-visibility/pages.ts`), always present and
 * empty when every row read.
 */
function servedPage<T>(
  items: readonly T[],
  options: { cursor: string | null; maxBytes?: number },
  unreadable: FixtureUnreadable[] = [],
) {
  return { ...pageList(items, options), unreadable };
}
const notFound = (what: string): FixtureResponse => ({ status: 404, body: { error: `${what} not found` } });

function optionalNumber(value: string | null): number | undefined {
  return value === null || value === "" ? undefined : Number(value);
}

function listOptions(query: URLSearchParams, cursorName = "cursor") {
  const limit = optionalNumber(query.get("limit"));
  return { cursor: query.get(cursorName), ...(limit === undefined ? {} : { maxBytes: limit }) };
}

/** What capture did with a run's sends, as the worker serves it beside the run
 *  state: the five counters plus the worker's own sum, so no reader adds up a
 *  different idea of what a send is. */
function captureCounts(run: FixtureRun) {
  if (run.capture === null) return null;
  const { captured, disabled, skipped, failed, conflict } = run.capture;
  return {
    captured,
    disabled,
    skipped,
    failed,
    conflict,
    sends: captured + disabled + skipped + failed + conflict,
    firstRecordedAt: "2026-09-19T08:29:00.000Z",
    lastRecordedAt: "2026-09-19T08:46:00.000Z",
  };
}

/** One Block Attempt as every read of a briefing serves it: the run's list, and
 *  the flow editor's "what did this block last send". */
function attemptItem(store: FixtureStore, entry: FixtureAttempt) {
  return {
    nodeId: entry.summary.nodeId,
    attempt: entry.summary.attempt,
    activationScopeId: entry.summary.activationScopeId,
    startedAt: entry.summary.startedAt,
    iteration: entry.iteration ?? null,
    sendsPrompts: entry.sendsPrompts,
    briefings: entry.briefingIds.map((briefingId) => ({ briefingId, overview: store.overviews.get(briefingId) })),
    missing: entry.missing,
  };
}

/**
 * `GET /workflow-definitions/{id}/nodes/{nodeId}/last-briefing`: what one block
 * last put in front of a model, over every run of the definition.
 *
 * It searches the runs rather than the definition, exactly as the worker does:
 * the newest run that touched the node wins whatever version it ran, and a
 * node that no run touched is answered from the block type alone.
 */
function nodeLastBriefingRoute(store: FixtureStore, definitionId: number, nodeId: string): FixtureResponse {
  const blockType = FIXTURE_DEFINITION_NODES.find((node) => node.nodeId === nodeId)?.blockType ?? null;
  let found: { run: FixtureRun; entry: FixtureAttempt } | null = null;
  for (const run of store.runs.values()) {
    for (const entry of run.attempts) {
      if (entry.summary.nodeId !== nodeId) continue;
      if (found === null || entry.summary.startedAt > found.entry.summary.startedAt) {
        found = { run, entry };
      }
    }
  }
  const answer = { schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION, definitionId, nodeId, blockType };
  if (found === null) {
    const sends = blockType === null ? null : PROMPT_SENDING.has(blockType);
    return ok({
      ...answer,
      sendsPrompts: sends,
      ranIn: null,
      attempt: null,
      absent: { kind: sends === false ? "sends_no_prompt" : "never_ran" },
    });
  }
  return ok({
    ...answer,
    sendsPrompts: found.entry.sendsPrompts,
    ranIn: {
      runId: found.run.runId,
      definitionVersion: found.run.definitionVersion,
      at: found.entry.summary.startedAt,
      state: found.run.briefingsState,
      capture: captureCounts(found.run),
    },
    attempt: attemptItem(store, found.entry),
    absent: null,
  });
}

function briefingRoute(store: FixtureStore, runId: string, rest: string[], query: URLSearchParams): FixtureResponse {
  const run = store.runs.get(runId);
  if (!run) return notFound("run");
  if (rest.length === 0) {
    const attempt = optionalNumber(query.get("attempt"));
    const items = run.attempts
      .filter(
        (entry) =>
          (query.get("nodeId") === null || entry.summary.nodeId === query.get("nodeId")) &&
          (attempt === undefined || entry.summary.attempt === attempt) &&
          (query.get("activationScopeId") === null ||
            entry.summary.activationScopeId === query.get("activationScopeId")),
      )
      .map((entry) => attemptItem(store, entry));
    return ok({ ...servedPage(items, listOptions(query)), state: run.briefingsState, capture: captureCounts(run) });
  }
  const [briefingId, collection, indexText, child] = rest;
  const index = store.briefings.get(briefingId!);
  if (!index || index.identity.runId !== runId) return notFound("briefing");
  if (collection === "repository-context" && rest.length === 2) {
    if (!index.repositoryContext) return notFound("repository context");
    const document = JSON.parse(store.texts.get(index.repositoryContext.sha256)!) as {
      unlistedCount: number;
      workScope: unknown;
      repositories: unknown[];
    };
    return ok({
      schemaVersion: AGENT_VISIBILITY_SCHEMA_VERSION,
      unlistedCount: document.unlistedCount,
      workScope: document.workScope,
      repositories: servedPage(document.repositories, listOptions(query)),
    });
  }
  if (collection === "unresolved-sources" && rest.length === 2) {
    return ok(servedPage(index.unresolvedSources, listOptions(query)));
  }
  if (collection !== "sections") return notFound("route");
  if (rest.length === 2) return ok(servedPage(index.sections.map(agentBriefingSectionHeader), listOptions(query)));
  const section = index.sections[Number(indexText)];
  if (!section) return notFound("section");
  if (child === undefined) {
    const offset = optionalNumber(query.get("offset"));
    const limit = optionalNumber(query.get("limit"));
    return ok(
      pageSectionText({
        sectionIndex: section.index,
        text: store.texts.get(section.storedSha256)!,
        ...(offset === undefined ? {} : { offset }),
        ...(limit === undefined ? {} : { maxBytes: limit }),
      }),
    );
  }
  if (child === "parts") return ok(servedPage(section.parts, listOptions(query)));
  if (child === "spans") return ok(servedPage(section.redactions, listOptions(query)));
  return notFound("route");
}

function workScopeRoute(store: FixtureStore, rest: string[], query: URLSearchParams): FixtureResponse {
  const subjectKey = query.get("subjectKey");
  if (subjectKey !== FIXTURE_SUBJECT) {
    const empty: WorkScopeRecordResponse = {
      subjectKey: subjectKey ?? "",
      carriesRecord: true,
      version: 0,
      entries: [],
      trail: [],
      nextTrailBeforeId: null,
    };
    return ok(query.get("rounds") === "true" ? { ...empty, rounds: servedPage([], { cursor: null }) } : empty);
  }
  if (rest.length === 0) {
    const record: WorkScopeRecordResponse = {
      subjectKey,
      carriesRecord: true,
      version: store.scope.version,
      entries: store.scope.entries,
      trail: [],
      nextTrailBeforeId: null,
    };
    // Rounds only when asked for: an older caller keeps its inline answer.
    if (query.get("rounds") !== "true") return ok(record);
    return ok({
      ...record,
      // One clarification row the worker could not read: it is in neither
      // `items` nor `total`, and the panel says so rather than showing one
      // question fewer without a word.
      rounds: servedPage(store.rounds.map(clarificationRoundHeader), listOptions(query, "roundsCursor"), [
        {
          rows: "clarifications",
          position: 2,
          id: "clr_unreadable",
          problem: "question.askedAt: must be an ISO 8601 time",
        },
      ]),
    });
  }
  const [rounds, roundId, collection] = rest;
  const round = store.rounds.find((entry) => entry.id === roundId);
  if (rounds !== "rounds" || !round) return notFound("round");
  if (collection === "deliveries") return ok(servedPage(round.deliveries, listOptions(query)));
  if (collection === "effects") return ok(servedPage(round.effects, listOptions(query)));
  return notFound("route");
}

const NOW = "2026-09-19T09:00:00.000Z";

function runRow(run: FixtureRun, started: number): TicketRunsResponse["runs"][number] {
  return {
    id: run.runId,
    workflow: "wf_agent",
    workflowName:
      run.runId === STATES_RUN
        ? "Fixture: every briefing state"
        : run.runId === OLD_RUN
          ? "Fixture: a run older than briefings"
          : "Ticket to pull request",
    status: run.status,
    statusReason: run.status === "failed" ? "The implementation attempt failed before its prompt went out." : null,
    ticket: FIXTURE_TICKET,
    actor: "ai-workflow",
    model: "claude-opus-4-1-20250805",
    startedAtMin: started,
    duration: 2_950,
    tokens: 184_000,
    cost: 3.42,
    spans: null,
    evalScore: null,
    guardrailHits: null,
    ticketTitle: "Checkout button does nothing on mobile",
    prNumber: null,
    ticketUrl: `https://acme.atlassian.net/browse/${FIXTURE_TICKET}`,
    prUrl: null,
    prs: null,
  };
}

function uiRoute(store: FixtureStore, path: string[], query: URLSearchParams): FixtureResponse | null {
  const runs = [
    store.runs.get(STATES_RUN)!,
    store.runs.get(PLANNING_RUN)!,
    store.runs.get(OLD_RUN)!,
    store.runs.get(EXPIRED_RUN)!,
  ];
  if (path[0] === "session") {
    return ok({
      organizationName: "Acme",
      actorLabel: FILIP,
      role: "owner",
      canManageUsers: true,
      canEditChecks: true,
      canEditWorkflows: true,
      canDispatchWorkflows: true,
    });
  }
  if (path[0] === "tickets" && path.length === 2) {
    const response: TicketRunsResponse = {
      generatedAt: NOW,
      available: true,
      ticket: { key: FIXTURE_TICKET, title: "Checkout button does nothing on mobile", url: `https://acme.atlassian.net/browse/${FIXTURE_TICKET}` },
      runs: runs.map((run, index) => runRow(run, 30 + index * 600)),
      totals: { cost: 13.68, tokens: 736_000, runCount: 4, counts: { success: 2, running: 0, awaiting: 1, failed: 1, blocked: 0 } },
    };
    return ok(response);
  }
  if (path[0] === "runs" && path[1] === "live") {
    const response: LiveRunsResponse = { generatedAt: NOW, rows: [] };
    return ok(response);
  }
  if (path[0] !== "runs" || path.length < 2) return null;
  const run = store.runs.get(path[1]!);
  if (!run) return notFound("run");
  if (path.length === 2) {
    const row = runRow(run, 30);
    const response: RunDetailResponse = {
      generatedAt: NOW,
      available: true,
      run: {
        id: run.runId,
        workflow: row.workflow,
        workflowName: row.workflowName,
        status: run.status,
        ticket: FIXTURE_TICKET,
        ticketTitle: row.ticketTitle,
        ticketUrl: row.ticketUrl,
        prNumber: null,
        prUrl: null,
        prs: null,
        model: row.model,
        createdAt: "2026-09-18T08:59:00.000Z",
        startedAt: "2026-09-18T08:59:00.000Z",
        completedAt: run.status === "awaiting" ? null : "2026-09-18T09:49:34.000Z",
        durationSec: 2_950,
        error: null,
        usageRecorded: true,
        statusReason: row.statusReason ?? null,
        deploymentId: null,
      },
      steps: [],
      analysisReport: null,
    };
    return ok(response);
  }
  if (path[2] === "replay") {
    const response: WorkflowRunReplayResponse =
      run.availability === "expired"
        ? { availability: "expired", mayAdvance: false, snapshot: null, attempts: [], nextCursor: null }
        : {
            availability: "available",
            mayAdvance: run.status === "awaiting",
            snapshot: {
              runId: run.runId,
              definitionId: 40,
              definitionVersion: 12,
              definitionSchemaVersion: 2,
              graph: { nodes: run.nodes, edges: [] },
              layout: { nodes: {}, edges: {} },
              runtimeManifest: {
                value: {},
                metadata: {
                  redactions: {},
                  truncated: false,
                  originalBytes: 2,
                  storedBytes: 2,
                  unavailable: false,
                  unavailableReason: null,
                },
              },
              captureStatus: "available",
              capturedAt: "2026-09-18T08:59:00.000Z",
              expiresAt: "2026-10-18T08:59:00.000Z",
            },
            attempts: run.attempts.map((entry) => entry.summary),
            nextCursor: null,
          };
    return ok(response);
  }
  if (path[2] === "attempts" && path.length === 4) {
    const attempt = run.attempts.find((entry) => String(entry.summary.id) === path[3]);
    if (!attempt) return notFound("attempt");
    const detail: WorkflowReplayAttemptDetail = { ...attempt.summary, input: null, output: null, logs: null, metadata: null };
    return ok(detail);
  }
  if (path[2] === "briefings") return briefingRoute(store, run.runId, path.slice(3), query);
  return null;
}

/**
 * A person's edit, answered the way `routes/api/v1/work-scope.patch.ts`
 * answers it: the version first, then a `select` outside the enabled catalog
 * refusing the whole change set, then the changes folded to the last one per
 * repository (`engine/work-scope/decide.ts`). A `remove` of a repository the
 * record does not hold is applied and changes nothing, as it does there.
 */
function editWorkScope(store: FixtureStore, body: unknown): FixtureResponse {
  const request = body as {
    subjectKey?: unknown;
    expectedVersion?: unknown;
    changes?: { repositoryKey?: unknown; action?: unknown; rationale?: unknown }[];
  } | null;
  const changes = Array.isArray(request?.changes) ? request.changes : [];
  if (request?.subjectKey !== FIXTURE_SUBJECT) {
    return { status: 400, body: { statusMessage: `${String(request?.subjectKey)} carries no work scope record, so there is nothing to edit.` } };
  }
  if (changes.length === 0) return { status: 400, body: { statusMessage: "changes: must hold at least 1 element" } };
  if (request.expectedVersion !== store.scope.version) {
    return { status: 409, body: { error: "version_conflict", latestVersion: store.scope.version } };
  }
  const refused = changes
    .filter((change) => change.action === "select" && !FIXTURE_ENABLED_KEYS.has(String(change.repositoryKey)))
    .map((change) => String(change.repositoryKey));
  if (refused.length > 0) {
    return {
      status: 400,
      body: {
        statusMessage: `The repository catalog does not enable ${refused.join(", ")}, so the whole edit was refused. Ask an owner or an admin to enable it on the Repositories page, or send the edit again without it.`,
      },
    };
  }
  const folded = new Map<string, (typeof changes)[number]>();
  for (const change of changes) folded.set(String(change.repositoryKey), change);
  const written = (repositoryKey: string, change: (typeof changes)[number]): WorkScopeEntry =>
    ({
      repositoryKey,
      state: change.action === "select" ? "selected" : "excluded",
      origin: "person",
      rationale: typeof change.rationale === "string" ? change.rationale : "",
      decidedBy: decidedByFilip,
      decidedAt: NOW,
    }) as WorkScopeEntry;
  // In place, so a row a person just changed does not jump down the list.
  const entries: WorkScopeEntry[] = [];
  for (const entry of store.scope.entries) {
    const change = folded.get(entry.repositoryKey);
    if (change === undefined) entries.push(entry);
    else if (change.action !== "remove") entries.push(written(entry.repositoryKey, change));
  }
  for (const [repositoryKey, change] of folded) {
    const known = store.scope.entries.some((entry) => entry.repositoryKey === repositoryKey);
    if (!known && change.action !== "remove") entries.push(written(repositoryKey, change));
  }
  store.scope = { version: store.scope.version + 1, entries };
  return ok({ scope: { subjectKey: FIXTURE_SUBJECT, version: store.scope.version, entries } });
}

/**
 * Answers a worker request (`/api/v1/...`) from the fixtures, or null for a
 * path the fixtures do not serve. A page request that cannot be served (an
 * offset inside a character, a cursor never handed out) is a 400, as the
 * worker answers it.
 */
export function serveFixture(store: FixtureStore, method: string, url: URL, body?: unknown): FixtureResponse | null {
  if (method === "PATCH" && url.pathname === "/api/v1/work-scope") return editWorkScope(store, body);
  if (method !== "GET" || !url.pathname.startsWith("/api/v1/")) return null;
  const path = url.pathname.slice("/api/v1/".length).split("/").filter(Boolean).map(decodeURIComponent);
  try {
    if (path[0] === "work-scope") return workScopeRoute(store, path.slice(1), url.searchParams);
    if (
      path[0] === "workflow-definitions" &&
      path[2] === "nodes" &&
      path[4] === "last-briefing" &&
      path.length === 5
    ) {
      return nodeLastBriefingRoute(store, Number(path[1]), path[3]!);
    }
    return uiRoute(store, path, url.searchParams);
  } catch (error) {
    if (error instanceof AgentVisibilityPageError) return { status: 400, body: { error: error.message } };
    throw error;
  }
}
