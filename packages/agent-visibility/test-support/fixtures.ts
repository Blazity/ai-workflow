/**
 * Hand-written inputs shaped like what the worker's capture adapter will pass,
 * modelled on `packages/prompts/effective-prompt.ts` (sections with kind, title,
 * content, provenance) and on the runtime parts stage 2 introduces. Nothing
 * here is produced by the code under test.
 */
import { createHash } from "node:crypto";
import type {
  AgentBriefingBuildInput,
  VisibilityRedaction,
  VisibilitySanitizer,
} from "../index";

export const sha = (text: string): string =>
  createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

export const bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/** Reports every occurrence of each listed secret by its input position,
 *  with the default replacement. A literal `[REDACTED]` already in the text is
 *  left alone, as a real sanitizer leaves it. */
export function fakeSanitizer(
  secrets: Record<string, string> = { "sk-live-SECRET": "secret" },
): VisibilitySanitizer {
  return (text: string) => {
    const found: VisibilityRedaction[] = [];
    for (const [secret, kind] of Object.entries(secrets)) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(secret, from);
        if (at < 0) break;
        found.push({ start: at, end: at + secret.length, kind });
        from = at + secret.length;
      }
    }
    return found;
  };
}

export const noSecrets: VisibilitySanitizer = () => [];

const RULE =
  "Repository access protocol: request a repository by its key and wait.";
export const TICKET = "AWP-235: The checkout button does nothing on mobile.";
export const COMMENT_ONE = "Filip: it started after the last deploy.";
export const COMMENT_TWO = "Anna: reproduced on iOS 18.";
export const RUNTIME_TEXT = `${RULE}\n\n${TICKET}\n\n${COMMENT_ONE}\n\n${COMMENT_TWO}`;

/**
 * DELIBERATELY NOT A PRODUCT MODEL ID. This package may import `@shared/contracts`
 * and nothing else, so it cannot read the model catalog, and a real identifier
 * written here by hand would be a second place that has to change on the day a
 * model is renamed, with nothing to say it had gone stale. Nothing these
 * fixtures prove depends on the string: the record carries whatever the send
 * reports.
 */
const FIXTURE_MODEL = "fixture-model-v1";

/** One planning pass: profile, a repository instruction file, memory, the
 *  block prompt and runtime data whose parts carry their origins. */
export function planningPassInput(): AgentBriefingBuildInput {
  return {
    identity: {
      runId: "wrun_01J8ZK6Q2V",
      nodeId: "planning",
      attempt: 1,
      activationScopeId: "root",
      sequence: 2,
      kind: "agent",
      blockType: "planning_agent",
      passLabel: "expansion round 1",
      capturedAt: "2026-09-19T10:15:00.000Z",
    },
    harness: {
      provider: "claude",
      model: FIXTURE_MODEL,
      outputSchema: '{"type":"object"}',
      skills: [{ id: "review-checklist", version: 3 }],
      profile: { id: "builtin-claude", version: 7 },
      wrapperScript: `#!/bin/sh\nclaude --print --model ${FIXTURE_MODEL}\n`,
      includeWorkflowData: true,
      includeRepositoryInstructions: true,
    },
    sections: [
      {
        kind: "profile",
        title: "Harness profile: Claude default",
        provenance: [{ kind: "profile", id: "builtin-claude", version: 7, hash: sha("Be precise.") }],
        text: "Be precise.",
      },
      {
        kind: "repository",
        title: "acme/web AGENTS.md",
        provenance: [{ kind: "repository", id: "acme/web:AGENTS.md", version: null, hash: sha("Run pnpm test.") }],
        text: "Run pnpm test.",
      },
      {
        kind: "memory",
        title: "acme/web facts",
        provenance: [{ kind: "memory", id: "acme/web:facts", version: null, hash: sha("Uses Next.js.") }],
        text: "Uses Next.js.",
      },
      {
        kind: "block",
        title: "Block role and task",
        provenance: [{ kind: "prompt", id: "p1:research-plan", version: 1, hash: sha("Plan the change.") }],
        text: "Plan the change.",
      },
      {
        kind: "runtime",
        title: "Runtime data",
        provenance: [{ kind: "runtime", id: "node:planning", version: null, hash: sha(RUNTIME_TEXT) }],
        text: RUNTIME_TEXT,
        parts: [
          { id: "platform:repository_access", title: "Repository access protocol", origin: { kind: "platform", ref: "repository-access-protocol" }, content: `${RULE}\n\n` },
          { id: "platform:resolution_check", title: "Resolution check", origin: { kind: "platform" }, content: "", withheld: { reason: "pr_feedback_present", text: "Pull request feedback is present, so the resolution check is not sent." } },
          { id: "ticket", title: "Ticket", origin: { kind: "ticket", ref: "AWP-235" }, content: `${TICKET}\n\n` },
          { id: "ticket_comment", title: "Comment by Filip", origin: { kind: "ticket_comment", ref: "10001", label: "Filip" }, content: `${COMMENT_ONE}\n\n` },
          { id: "ticket_comment", title: "Comment by Anna", origin: { kind: "ticket_comment", ref: "10002", label: "Anna" }, content: COMMENT_TWO },
        ],
      },
    ],
    repositoryContext: {
      repositories: [
        {
          key: "github:acme/web",
          description: { source: "catalog", text: "The storefront." },
          rules: "Never touch payments.",
          relationships: [{ kind: "frontend_for", target: "github:acme/api" }],
          state: "write",
          inclusion: { cause: "named" },
          rendering: "full",
          workScopeEntry: null,
        },
        {
          key: "github:acme/api",
          description: { source: "provider", text: "API" },
          rules: null,
          relationships: [],
          state: "read_only",
          inclusion: { cause: "related", via: { key: "github:acme/web", relationship: "frontend_for" } },
          rendering: "full",
          workScopeEntry: null,
        },
        {
          key: "github:acme/legacy",
          description: { source: "none", text: "" },
          rules: null,
          relationships: [],
          state: "excluded",
          reason: "Excluded by Filip: not part of this work.",
          inclusion: { cause: "work_scope_entry" },
          rendering: "line",
          workScopeEntry: {
            repositoryKey: "github:acme/legacy",
            state: "excluded",
            origin: "person",
            rationale: "not part of this work",
            decidedBy: { kind: "person", actorId: "u1", actorLabel: "Filip" },
            decidedAt: "2026-09-18T09:00:00.000Z",
          },
        },
      ],
      unlistedCount: 0,
      workScope: { version: 4, leftOutKeys: ["github:acme/legacy"] },
    },
    unresolvedSources: [],
  };
}

/** Text of exactly `length` UTF-16 units, Polish letters included. */
export function prose(seed: string, length: number): string {
  const unit = `${seed}: owns checkout, cart and pricing for the shop; zażółć gęślą jaźń. `;
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

/**
 * The shape stage 6 must hold: a planning pass that shows the whole ranked
 * map of a 150-repository catalog whose profiles are 5 KB each, and runtime
 * data carrying 120 pull request thread comments.
 */
export function stageSixInput(): AgentBriefingBuildInput {
  const input = planningPassInput();
  const threads = Array.from({ length: 120 }, (_unused, index) => ({
    id: "pr_thread",
    title: `Review thread ${index + 1} on src/checkout/cart.ts`,
    origin: { kind: "pr_thread", ref: `discussion-${index + 1}`, label: index % 2 === 0 ? "Anna" : "Filip" },
    content: `${prose(`thread ${index + 1}`, 400)}\n\n`,
  }));
  const parts = [...input.sections[4]!.parts!, ...threads];
  input.sections[4] = {
    ...input.sections[4]!,
    parts,
    text: parts.map((part) => part.content).join(""),
  };
  input.repositoryContext = {
    repositories: Array.from({ length: 150 }, (_unused, index) => {
      const disabled = index % 25 === 24;
      return {
        key: `github:acme/service-${index}`,
        description: { source: "catalog", text: prose(`service ${index}`, 5_120) },
        rules: index < 20 ? prose(`rules ${index}`, 1_000) : null,
        relationships: index > 0 ? [{ kind: "depends_on", target: `github:acme/service-${index - 1}` }] : [],
        state: index < 3 ? "write" : disabled ? "disabled" : "offered",
        ...(disabled ? { reason: "Disabled in the catalog by an administrator: do not request it." } : {}),
        inclusion: index < 3 ? { cause: "named" } : { cause: "catalog" },
        rendering: index < 20 ? "full" : "line",
        workScopeEntry: null,
      };
    }),
    unlistedCount: 0,
    workScope: { version: 2, leftOutKeys: [] },
    renderedAt: { sectionIndex: 4, partId: "platform:repository_access" },
  };
  return input;
}
