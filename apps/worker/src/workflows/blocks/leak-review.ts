import { z } from "zod";
import type { JsonValue } from "@shared/contracts";
import type { Sandbox as SandboxType } from "@vercel/sandbox";
import { configuredReplaySecrets } from "../../run-observability/configured-secrets.js";
import { redactConfiguredSecretsInText } from "../../run-observability/sanitizer.js";
import {
  workspaceRepositoryAccess,
  type WorkspaceManifest,
} from "../../sandbox/repo-workspace.js";
import { RunBudgetError } from "../run-budget.js";
import { isRunControlError } from "../run-control-error.js";
import { resolveCallLlmTarget } from "./call-llm.js";
import {
  executionError,
  markBlockPhaseLaunched,
  recordBlockPhaseUsage,
  type BlockExecuteFn,
  type BlockExecutionResult,
} from "./types.js";

export const paramsSchema = z
  .object({
    model: z.string().trim().max(200).regex(/^[A-Za-z0-9._:\/-]+$/).optional(),
    llmScan: z.boolean().optional(),
    maxDiffBytes: z.number().int().positive().max(262_144).optional(),
  })
  .strict();

type SandboxInstance = Awaited<ReturnType<typeof SandboxType.get>>;

const DEFAULT_MAX_DIFF_BYTES = 131_072;
const MAX_LLM_FINDINGS = 20;
const MAX_EXCERPT_CHARS = 40;
const MAX_REASON_CHARS = 200;
const MAX_FILE_CHARS = 200;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_REPORTED_HITS = 5;
const MAX_COLLECTED_HITS = 50;
const MAX_DIFF_STAT_CHARS = 2_000;
/**
 * A configured environment value shorter than this cannot identify a leak, and
 * matching it would fail every run that happens to contain those characters.
 */
const MIN_CONFIGURED_SECRET_CHARS = 8;

const REPO_MARKER = "### repo ";
const COMMITS_MARKER = "## commit messages";
const DIFF_MARKER = "## diff";
const DIFF_FILE_MARKER = "+++ b/";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Only unambiguous, self-identifying secret shapes belong here: one match fails
 * the run before publication, so a false positive blocks real work.
 */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "private_key_block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: "anthropic_api_key", pattern: /sk-ant-[a-zA-Z0-9-]{20,}/ },
  // The lookahead pins today's exact 40-character GitHub token length (prefix
  // plus 36). If GitHub ever changes the format, this pattern goes fail-open and
  // must be re-verified rather than trusted.
  { kind: "github_token", pattern: /gh[po]_[A-Za-z0-9]{36}(?![A-Za-z0-9])/ },
  { kind: "github_pat", pattern: /github_pat_[A-Za-z0-9_]{22,}/ },
  { kind: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/ },
  { kind: "slack_token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: "gitlab_token", pattern: /glpat-[A-Za-z0-9_-]{20,}/ },
  // The scheme run is bounded so no input can make this backtrack super-linearly.
  { kind: "url_credentials", pattern: /[a-z][a-z0-9+.-]{0,31}:\/\/[^/\s:]+:[^@\s]+@/ },
];

/** Global twins of the scanning patterns, used to mask every occurrence in
 * model-authored text. Hoisted so no request-time RegExp compilation happens. */
const SECRET_MASK_PATTERNS: readonly RegExp[] = SECRET_PATTERNS.map(
  ({ pattern }) => new RegExp(pattern.source, "g"),
);

/** Long opaque runs are masked defensively wherever model text is reused. */
const OPAQUE_TOKEN_PATTERN = /[A-Za-z0-9_-]{32,}/g;

const LLM_FINDING_KINDS = [
  "secret",
  "credential",
  "client_name",
  "pii",
  "internal_url",
  "other",
] as const;
const LLM_FINDING_SEVERITIES = ["high", "medium", "low"] as const;

type LeakReviewFindingKind = (typeof LLM_FINDING_KINDS)[number];
type LeakReviewFindingSeverity = (typeof LLM_FINDING_SEVERITIES)[number];

interface LeakReviewFinding extends Record<string, JsonValue> {
  kind: LeakReviewFindingKind;
  severity: LeakReviewFindingSeverity;
  file: string;
  excerpt: string;
  reason: string;
}

const LLM_OUTPUT_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...LLM_FINDING_KINDS] },
          severity: { type: "string", enum: [...LLM_FINDING_SEVERITIES] },
          file: { type: "string" },
          excerpt: { type: "string" },
          reason: { type: "string" },
        },
        required: ["kind", "severity", "file", "excerpt", "reason"],
        additionalProperties: false,
      },
    },
    summary: { type: "string" },
  },
  required: ["findings", "summary"],
  additionalProperties: false,
});

const LLM_SYSTEM_PROMPT = `You screen an unpublished code change for sensitive data that must not reach the client's repository.

Judge ONLY added diff lines (lines starting with "+") and the commit messages in the material.

Report each finding with a kind:
- "secret": an API key, token, password, or private key
- "credential": credentials embedded in a connection string, URL, or config value
- "client_name": a customer, client, or partner name that exposes a private engagement
- "pii": an email address, phone number, postal address, or other personal data
- "internal_url": an internal-only host, dashboard, or endpoint
- "other": anything else that must not be published

Do NOT flag:
- public URLs, documentation links, or package names
- license headers and copyright notices
- test fixtures and obviously fake placeholder values
- pre-existing content on context lines (no leading "+")

Every excerpt MUST be masked: at most 40 characters, and any secret-looking value must appear as a short prefix followed by "****". Never repeat a full secret value.

Return { "findings": [], "summary": "..." } when the change is clean.`;

interface LeakReviewRepository {
  provider: "github" | "gitlab";
  repoPath: string;
  localPath: string;
  preAgentSha: string;
}

/** Masked deterministic match. The raw matched value never leaves the step. */
interface SecretHit {
  kind: string;
  location: string;
  masked: string;
}

interface LeakReviewCollectResult {
  /**
   * Scan material for the optional LLM pass, capped at maxDiffBytes.
   * Deliberately empty once the deterministic layer matched: that run fails, so
   * no material carrying a detected secret ever crosses the step boundary.
   */
  material: string;
  diffStat: string;
  /** True when the LLM material was capped. The deterministic layer always sees
   * every byte of every screened repository, so this never weakens the gate. */
  truncated: boolean;
  hits: SecretHit[];
  scanned: string[];
  unchanged: string[];
}

type LeakReviewLlmScanResult =
  | {
      ok: true;
      findings: LeakReviewFinding[];
      summary: string;
      usage: { inputTokens: number; outputTokens: number; cachedTokens: number } | null;
      durationMs: number;
    }
  | { ok: false };

function utf8Bytes(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

/** Largest prefix at or below maxBytes that does not split a character. */
function sliceUtf8Head(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = utf8Encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1;
  return utf8Decoder.decode(encoded.subarray(0, end));
}

/** Pattern matches are public markers ("sk-ant-", "ghp_"), so a fixed prefix
 * leaks nothing useful. */
function maskSecretValue(value: string): string {
  return `${value.slice(0, 8)}****`;
}

/** A configured value has no public prefix, so the retained head scales with its
 * length: a short secret must not be mostly reconstructable from its mask. */
function maskConfiguredSecretValue(value: string): string {
  const keep = Math.min(8, Math.max(2, Math.floor(value.length / 3)));
  return `${value.slice(0, keep)}****`;
}

function scannableConfiguredSecrets(configuredSecrets: readonly string[]): string[] {
  return [...configuredSecrets]
    .filter((secret) => secret.length >= MIN_CONFIGURED_SECRET_CHARS)
    .sort((left, right) => right.length - left.length);
}

function collectLineHits(
  hits: SecretHit[],
  line: string,
  location: string,
  secrets: readonly string[],
): void {
  for (const { kind, pattern } of SECRET_PATTERNS) {
    const match = pattern.exec(line);
    if (match) hits.push({ kind, location, masked: maskSecretValue(match[0]) });
  }
  if (secrets.length > 0 && redactConfiguredSecretsInText(line, secrets) !== line) {
    const matched = secrets.find((secret) => line.includes(secret));
    hits.push({
      kind: "configured_environment_secret",
      location,
      masked: matched === undefined ? "****" : maskConfiguredSecretValue(matched),
    });
  }
}

/**
 * Scan one repository's unpushed contribution. Commit messages are scanned in
 * full because a secret pasted into a message is published exactly like one in a
 * file; in the diff only added lines count, since context lines are already in
 * the client's history and removed lines are leaving the tree. The scan reads
 * the raw git output rather than the marked-up LLM material, so no crafted
 * commit message can spoof a section boundary and hide a line from the gate.
 *
 * Once MAX_COLLECTED_HITS is reached the remaining lines and repositories are
 * left unscanned: the run fails on what was already found, so the reported list
 * is deliberately a bounded sample rather than an exhaustive inventory.
 */
function appendSecretHits(
  hits: SecretHit[],
  repoLabel: string,
  commitMessages: string,
  diff: string,
  secrets: readonly string[],
): void {
  for (const line of commitMessages.split("\n")) {
    if (hits.length >= MAX_COLLECTED_HITS) return;
    collectLineHits(hits, line, `${repoLabel} (commit messages)`, secrets);
  }
  let file = "";
  for (const line of diff.split("\n")) {
    if (hits.length >= MAX_COLLECTED_HITS) return;
    if (line.startsWith(DIFF_FILE_MARKER)) {
      file = line.slice(DIFF_FILE_MARKER.length).trim();
      continue;
    }
    // Only these two exact headers are skipped. Anything broader would skip an
    // added line whose own content starts with "++", which git renders with the
    // added-line marker as "+++...".
    if (line === "+++ /dev/null") continue;
    if (!line.startsWith("+")) continue;
    collectLineHits(
      hits,
      line,
      file !== "" ? `${repoLabel}:${file}` : `${repoLabel} (diff)`,
      secrets,
    );
  }
}

function describeSecretHits(hits: readonly SecretHit[]): string {
  const listed = hits
    .slice(0, MAX_REPORTED_HITS)
    .map((hit) => `${hit.kind} in ${hit.location} (${hit.masked})`);
  const remaining = hits.length - listed.length;
  return (
    `${hits.length} high-confidence secret match${hits.length === 1 ? "" : "es"}: ` +
    listed.join("; ") +
    (remaining > 0 ? `; and ${remaining} more` : "")
  );
}

/**
 * Never trust model text: mask configured secrets and secret-shaped runs. An
 * opaque run under 32 characters of unknown shape can still come back verbatim,
 * which is acceptable for a report-only excerpt: the deterministic layer already
 * cleared every known secret shape, and replay sanitization redacts configured
 * secrets again downstream.
 */
function sanitizeModelText(value: string, maxChars: number): string {
  let text = redactConfiguredSecretsInText(value, configuredReplaySecrets());
  for (const pattern of SECRET_MASK_PATTERNS) {
    text = text.replace(pattern, (match) => maskSecretValue(match));
  }
  text = text.replace(OPAQUE_TOKEN_PATTERN, (token) => maskSecretValue(token));
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function normalizeLlmFindings(raw: unknown): LeakReviewFinding[] {
  if (raw === null || typeof raw !== "object") return [];
  const findings = (raw as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return [];
  return findings.slice(0, MAX_LLM_FINDINGS).flatMap((entry) => {
    if (entry === null || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    const kind = LLM_FINDING_KINDS.find((candidate) => candidate === record.kind) ?? "other";
    const severity =
      LLM_FINDING_SEVERITIES.find((candidate) => candidate === record.severity) ?? "low";
    return [
      {
        kind,
        severity,
        file: sanitizeModelText(
          typeof record.file === "string" ? record.file : "",
          MAX_FILE_CHARS,
        ),
        excerpt: sanitizeModelText(
          typeof record.excerpt === "string" ? record.excerpt : "",
          MAX_EXCERPT_CHARS,
        ),
        reason: sanitizeModelText(
          typeof record.reason === "string" ? record.reason : "",
          MAX_REASON_CHARS,
        ),
      },
    ];
  });
}

function normalizeLlmSummary(raw: unknown): string {
  if (raw === null || typeof raw !== "object") return "";
  const summary = (raw as { summary?: unknown }).summary;
  return typeof summary === "string" ? sanitizeModelText(summary, MAX_SUMMARY_CHARS) : "";
}

async function readGitOutput(
  sandbox: SandboxInstance,
  localPath: string,
  args: string[],
  label: string,
): Promise<string> {
  const result = await sandbox.runCommand("git", ["-C", localPath, ...args]);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args[0]} failed for ${label}`);
  }
  return result.stdout();
}

/**
 * Collect the unpushed contribution of every write repository and scan it
 * deterministically inside the step, so a detected secret is reported only as a
 * masked hit. HEAD comes from the checkout, never from the manifest, and the
 * range is pinned to the sha we just read. The byte cap applies to the LLM
 * material only: every screened repository is scanned in full, so a secret at
 * the tail of a huge diff, or in a repository the cap already excluded from the
 * LLM material, still fails the run.
 */
async function blockLeakReviewCollectStep(input: {
  sandboxId: string;
  repositories: LeakReviewRepository[];
  maxBytes: number;
}): Promise<LeakReviewCollectResult> {
  "use step";
  const { Sandbox } = await import("@vercel/sandbox");
  const { getSandboxCredentials } = await import("../../sandbox/credentials.js");
  const sandbox = await Sandbox.get({
    sandboxId: input.sandboxId,
    ...getSandboxCredentials(),
  });

  const secrets = scannableConfiguredSecrets(configuredReplaySecrets());
  const sections: string[] = [];
  const diffStats: string[] = [];
  const scanned: string[] = [];
  const unchanged: string[] = [];
  const hits: SecretHit[] = [];
  let truncated = false;
  let remaining = input.maxBytes;

  for (const repo of input.repositories) {
    const label = `${repo.provider}:${repo.repoPath}`;
    const head = (
      await readGitOutput(sandbox, repo.localPath, ["rev-parse", "HEAD"], label)
    ).trim();
    if (head === "") throw new Error(`git rev-parse returned no HEAD for ${label}`);
    if (head === repo.preAgentSha) {
      unchanged.push(label);
      continue;
    }
    // preAgentSha..HEAD is exactly what the agent authored. Publication bundles
    // expectedRemoteSha..HEAD, which additionally carries the local base merge;
    // those commits only bring content the client's remote already has, so
    // screening the agent's own range deliberately leaves them out.
    const range = `${repo.preAgentSha}..${head}`;
    const stat = await readGitOutput(
      sandbox,
      repo.localPath,
      ["diff", "--stat", range],
      label,
    );
    const log = await readGitOutput(
      sandbox,
      repo.localPath,
      ["log", "--format=%s%n%b", range],
      label,
    );
    const diff = await readGitOutput(
      sandbox,
      repo.localPath,
      ["diff", "--unified=3", range],
      label,
    );
    scanned.push(label);
    if (stat.trim() !== "") diffStats.push(`${label}\n${stat.trim()}`);

    appendSecretHits(hits, label, log, diff, secrets);

    const section = [
      `${REPO_MARKER}${label}`,
      COMMITS_MARKER,
      log,
      DIFF_MARKER,
      diff,
    ].join("\n");
    const allowed = sliceUtf8Head(section, remaining);
    if (allowed.length < section.length) truncated = true;
    remaining -= utf8Bytes(allowed);
    if (allowed !== "") sections.push(allowed);
  }

  const material = sections.join("\n");
  const diffStat = diffStats.join("\n");
  return {
    material: hits.length > 0 ? "" : material,
    diffStat:
      diffStat.length > MAX_DIFF_STAT_CHARS
        ? diffStat.slice(0, MAX_DIFF_STAT_CHARS)
        : diffStat,
    truncated,
    hits,
    scanned,
    unchanged,
  };
}
blockLeakReviewCollectStep.maxRetries = 0;

/**
 * Report-only LLM pass. Provider failures are logged inside the step (pino is a
 * Node module and cannot be reached from workflow scope) and reported as a
 * skipped scan, because this layer must never fail a run.
 */
async function blockLeakReviewLlmScanStep(input: {
  model: string;
  provider?: "claude" | "codex";
  material: string;
  timeoutMs: number;
}): Promise<LeakReviewLlmScanResult> {
  "use step";
  const { generateStructured } = await import("../../lib/llm.js");
  const startedAt = Date.now();
  try {
    const result = await generateStructured({
      model: input.model,
      ...(input.provider !== undefined ? { provider: input.provider } : {}),
      system: LLM_SYSTEM_PROMPT,
      prompt: `Unpublished change material:\n\n${input.material}`,
      schema: LLM_OUTPUT_SCHEMA,
      timeoutMs: input.timeoutMs,
    });
    return {
      ok: true,
      findings: normalizeLlmFindings(result.object),
      summary: normalizeLlmSummary(result.object),
      usage: result.usage,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    if (isRunControlError(err)) throw err;
    const { logger } = await import("../../lib/logger.js");
    // A provider error can echo request content back, so redact and bound it
    // before it reaches a log sink.
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      {
        err: redactConfiguredSecretsInText(message, configuredReplaySecrets()).slice(0, 500),
      },
      "leak_review_llm_scan_failed",
    );
    return { ok: false };
  }
}
blockLeakReviewLlmScanStep.maxRetries = 0;

function collectionSummary(
  collected: Pick<LeakReviewCollectResult, "scanned" | "unchanged" | "truncated">,
  unbaselined: number,
): string {
  const parts = [
    `Screened ${collected.scanned.length} ${plural(collected.scanned.length, "repository", "repositories")} for secrets and sensitive data.`,
  ];
  if (collected.unchanged.length > 0) {
    parts.push(
      `${collected.unchanged.length} unchanged ${plural(collected.unchanged.length, "repository", "repositories")} skipped.`,
    );
  }
  if (unbaselined > 0) {
    parts.push(
      `${unbaselined} ${plural(unbaselined, "repository", "repositories")} had no baseline commit and could not be screened.`,
    );
  }
  if (collected.truncated) {
    parts.push(
      "The material sent to the LLM scan hit the size cap; the secret scan still covered every screened repository in full.",
    );
  }
  return parts.join(" ");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function writeRepositoriesOf(manifest: WorkspaceManifest): LeakReviewRepository[] {
  return manifest.repositories
    .filter(
      (repo) =>
        workspaceRepositoryAccess(manifest, repo) === "write" &&
        typeof repo.preAgentSha === "string" &&
        repo.preAgentSha.length > 0,
    )
    .map((repo) => ({
      provider: repo.provider,
      repoPath: repo.repoPath,
      localPath: repo.localPath,
      preAgentSha: repo.preAgentSha!,
    }));
}

/**
 * leak_review: last gate before finalize_workspace pushes the branch. The
 * deterministic layer is fail-closed: one high-confidence secret or configured
 * environment secret in the unpushed diff or a commit message ends the run with
 * an execution error and no LLM call. The optional LLM layer is report-only, so
 * its findings surface as status "flagged" and the run continues; even a
 * provider failure leaves status "ok". No secret value ever reaches the output,
 * a log line, or a failure message: only masked prefixes do.
 */
export const execute: BlockExecuteFn = async (
  block,
  _steps,
  ctx,
  _resolvedInputs,
  execution,
): Promise<BlockExecutionResult> => {
  if (!ctx.sandboxId) {
    return executionError("no workspace: connect prepare_workspace before leak_review", {
      category: "sandbox",
    });
  }
  if (!ctx.workspaceManifest) {
    return executionError("workspace has no manager-authored trusted manifest", {
      category: "sandbox",
    });
  }

  const manifest = ctx.workspaceManifest;
  const publishable = manifest.repositories.filter(
    (repo) => workspaceRepositoryAccess(manifest, repo) === "write",
  );
  const repositories = writeRepositoriesOf(manifest);
  const unbaselined = publishable.length - repositories.length;
  const maxBytes =
    typeof block.params.maxDiffBytes === "number" && block.params.maxDiffBytes > 0
      ? Math.floor(block.params.maxDiffBytes)
      : DEFAULT_MAX_DIFF_BYTES;

  if (repositories.length === 0) {
    return {
      kind: "next",
      output: {
        status: "skipped",
        findings: [],
        summary: collectionSummary(
          { scanned: [], unchanged: [], truncated: false },
          unbaselined,
        ),
        diffStat: "",
        truncated: false,
      },
    };
  }

  let collected: LeakReviewCollectResult;
  try {
    collected = await blockLeakReviewCollectStep({
      sandboxId: ctx.sandboxId,
      repositories,
      maxBytes,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return executionError(err instanceof Error ? err.message : String(err), {
      category: "sandbox",
    });
  }

  if (collected.hits.length > 0) {
    const described = describeSecretHits(collected.hits);
    return executionError(`leak_review blocked publication: ${described}`, {
      category: "checks",
      message:
        `Leak review blocked publication before the branch was pushed: ${described}. ` +
        "Remove the secret from the change and rerun.",
    });
  }

  if (collected.scanned.length === 0) {
    return {
      kind: "next",
      output: {
        status: "skipped",
        findings: [],
        summary: collectionSummary(collected, unbaselined),
        diffStat: collected.diffStat,
        truncated: collected.truncated,
      },
    };
  }

  const baseSummary = collectionSummary(collected, unbaselined);
  const reportOnly = (summary: string): BlockExecutionResult => ({
    kind: "next",
    output: {
      status: "ok",
      findings: [],
      summary: `${baseSummary} ${summary}`,
      diffStat: collected.diffStat,
      truncated: collected.truncated,
    },
  });

  if (block.params.llmScan === false) {
    return reportOnly("The LLM scan is disabled for this block.");
  }

  const { provider, model } = resolveCallLlmTarget(
    block.params,
    ctx.runDefaultKind,
    ctx.defaults,
  );
  const budget = await ctx.observeBudget();
  if (budget.check.status !== "ok") throw new RunBudgetError(budget.check);
  const timeoutMs = Math.max(1, Math.floor(budget.remainingDurationMs));
  const usageLabel = `Leak review ${block.id}`;
  markBlockPhaseLaunched(ctx, usageLabel, execution);

  /**
   * Report-only covers findings, not run control: a scan that ended because the
   * run ran out of budget or duration must fail the run exactly like Call LLM
   * does, instead of walking on to Finalize with an unscreened diff.
   */
  const llmUnavailable = async (): Promise<BlockExecutionResult> => {
    recordBlockPhaseUsage(ctx, usageLabel, null, model, execution);
    const after = await ctx.observeBudget();
    if (after.check.status !== "ok") throw new RunBudgetError(after.check);
    if (after.remainingDurationMs <= 0) {
      const limit = after.durationLimitMs ?? after.activeElapsedMs ?? 0;
      const consumed = after.activeElapsedMs ?? limit;
      throw new RunBudgetError({
        status: "budget_exceeded",
        metric: "duration",
        limit,
        consumed,
        reason: `budget_exceeded: duration ${consumed} reached limit ${limit} during Leak review`,
      });
    }
    return reportOnly("The LLM scan was skipped after a provider error.");
  };

  let scan: LeakReviewLlmScanResult;
  try {
    scan = await blockLeakReviewLlmScanStep({
      model,
      ...(provider !== undefined ? { provider } : {}),
      material: collected.material,
      timeoutMs,
    });
  } catch (err) {
    if (isRunControlError(err)) throw err;
    return llmUnavailable();
  }

  if (!scan.ok) return llmUnavailable();

  recordBlockPhaseUsage(
    ctx,
    usageLabel,
    scan.usage
      ? {
          cost_usd: null,
          tokens: {
            input: scan.usage.inputTokens,
            cached_input: scan.usage.cachedTokens,
            output: scan.usage.outputTokens,
          },
          duration_ms: scan.durationMs,
          duration_api_ms: scan.durationMs,
          num_turns: 1,
        }
      : null,
    model,
    execution,
  );

  const summary =
    scan.summary !== ""
      ? `${baseSummary} ${scan.summary}`
      : `${baseSummary} The LLM scan reported ${scan.findings.length} ${plural(scan.findings.length, "finding", "findings")}.`;
  return {
    kind: "next",
    output: {
      status: scan.findings.length > 0 ? "flagged" : "ok",
      findings: scan.findings,
      summary,
      diffStat: collected.diffStat,
      truncated: collected.truncated,
    },
  };
};
