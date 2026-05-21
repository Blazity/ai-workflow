import type { CheckCacheManifest, CheckResult } from "../lib/checks/types.js";
import type { CheckConfig } from "../lib/workflow-config.js";
import type { ReviewBundle } from "../lib/pr-context.js";
import type { CheckRunRef } from "../adapters/vcs/types.js";
import type { ReviewPromptSource } from "./prompts-step.js";

export interface ReviewWorkflowArgs {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  action: string;
}

// ---------------------------------------------------------------------------
// Step functions
// ---------------------------------------------------------------------------

async function loadReviewConfigStep() {
  "use step";
  const { loadConfig } = await import("../lib/workflow-config.js");
  return loadConfig({ requireWebhookSecret: true });
}

async function getVcsKindStep(): Promise<string> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  return getVcsConfig().kind;
}

async function buildBundleStep(
  args: { owner: string; repo: string; prNumber: number },
  bundleRequest: import("../lib/pr-context.js").ReviewBundleRequest,
): Promise<ReviewBundle> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");
  const { buildReviewBundle } = await import("../lib/pr-context.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  return buildReviewBundle(vcs, args, bundleRequest);
}

async function findOrCreateCheckRunStep(args: {
  owner: string;
  repo: string;
  headSha: string;
  configHash: string;
  checkId: string;
  name: string;
}): Promise<{ checkRunRef: CheckRunRef; alreadyCompleted: boolean }> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter, buildCheckRunExternalId } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  const externalId = buildCheckRunExternalId(args.configHash, args.checkId, args.headSha);

  const existing = await vcs.listCheckRunsForRef!(args.headSha);
  const found = existing.find((c) => c.external_id === externalId);

  if (found) {
    return {
      checkRunRef: found,
      alreadyCompleted: found.status === "completed",
    };
  }

  const created = await vcs.createCheckRun!({
    name: args.name,
    head_sha: args.headSha,
    external_id: externalId,
    status: "queued",
  });

  return { checkRunRef: created, alreadyCompleted: false };
}

async function updateCheckRunStep(args: {
  owner: string;
  repo: string;
  checkRunId: number;
  update: import("../adapters/vcs/types.js").CheckRunUpdateInput;
}): Promise<CheckRunRef> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  // Timestamps are computed inside the step (not in the workflow body) so
  // they are persisted in the step's checkpointed return value and remain
  // stable across replays.
  const update = { ...args.update };
  const nowIso = new Date().toISOString();
  if (update.status === "in_progress" && !update.started_at) {
    update.started_at = nowIso;
  }
  if (update.status === "completed" && !update.completed_at) {
    update.completed_at = nowIso;
  }

  return vcs.updateCheckRun!(args.checkRunId, update);
}

async function runCheckStep(args: {
  kind: string;
  params: Record<string, unknown>;
  ctx: import("../lib/checks/types.js").CheckContext;
}): Promise<CheckResult> {
  "use step";
  // Trigger self-registration via side effects
  await import("../lib/checks/complexity.js");
  await import("../lib/checks/ai-review.js");

  const { getCheck } = await import("../lib/checks/registry.js");
  const check = getCheck(args.kind);
  if (!check) {
    throw new Error(`Unknown check kind: ${args.kind}`);
  }

  const parsed = check.paramsSchema.parse(args.params ?? {});
  return check.run(parsed, args.ctx);
}

async function loadPromptStep(spec: ReviewPromptSource) {
  "use step";
  const { loadReviewPrompt } = await import("./prompts-step.js");
  return loadReviewPrompt(spec);
}

async function listPreviousCacheStep(args: {
  owner: string;
  repo: string;
  headSha: string;
  checkId: string;
  configHash: string;
}): Promise<CheckCacheManifest | null> {
  "use step";
  // Decision (v1): load cache from the current headSha's check runs only.
  // Cross-commit cache lookup is deferred to a follow-up milestone to avoid
  // complexity. If no completed run with a manifest is found, return null.
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter, buildCheckRunExternalId } = await import("../adapters/vcs/github.js");
  const { parseCacheManifest } = await import("../lib/checks/cache.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  const externalId = buildCheckRunExternalId(args.configHash, args.checkId, args.headSha);
  const runs = await vcs.listCheckRunsForRef!(args.headSha);
  const completed = runs.find(
    (r) => r.external_id === externalId && r.status === "completed" && r.output_text,
  );
  if (!completed) return null;
  return parseCacheManifest(completed.output_text ?? null);
}

async function listExistingCommentsStep(args: {
  owner: string;
  repo: string;
  prNumber: number;
}) {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  return vcs.listExistingReviewComments!(args.prNumber);
}

/**
 * Fetch annotations from a previous Check Run so cache-hit files can carry
 * their prior annotations forward onto the new Check Run. Returns an empty
 * array if the adapter doesn't implement `listCheckRunAnnotations` or the
 * fetch fails — the workflow logs a warning and skips copy-forward rather
 * than failing.
 */
async function listCheckRunAnnotationsStep(args: {
  owner: string;
  repo: string;
  checkRunId: number;
}): Promise<import("../adapters/vcs/types.js").CheckRunAnnotation[]> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  if (typeof vcs.listCheckRunAnnotations !== "function") {
    return [];
  }
  try {
    return await vcs.listCheckRunAnnotations(args.checkRunId);
  } catch {
    return [];
  }
}

async function createReviewStep(args: {
  owner: string;
  repo: string;
  prNumber: number;
  comments: import("../adapters/vcs/types.js").ReviewCommentInput[];
  body: string;
}): Promise<void> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  await vcs.createReview!(args.prNumber, args.comments, args.body);
}

/**
 * Fetch the PR's current head SHA so we can detect when the workflow is about
 * to post results for a stale commit (the user pushed a newer commit while we
 * were running). Returns null on fetch failure — callers treat null as
 * "couldn't determine, proceed conservatively" rather than skipping the post.
 */
async function checkHeadStillCurrentStep(args: {
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<string | null> {
  "use step";
  const { getVcsConfig } = await import("../../env.js");
  const { GitHubAdapter } = await import("../adapters/vcs/github.js");

  const vcsConfig = getVcsConfig();
  if (vcsConfig.kind !== "github") {
    throw new Error(`Review workflow only supports GitHub VCS (got: ${vcsConfig.kind})`);
  }

  const vcs = new GitHubAdapter({
    auth: vcsConfig.auth,
    owner: args.owner,
    repo: args.repo,
    baseBranch: vcsConfig.baseBranch,
  });

  try {
    const pr = await vcs.getPullRequest!(args.prNumber);
    return pr.head.sha;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workflow helpers (not steps — called in workflow body)
// ---------------------------------------------------------------------------

/**
 * Compute the union of data needed across all enabled checks so we fetch
 * each piece at most once.
 */
function computeBundleRequest(
  config: import("../lib/workflow-config.js").WorkflowConfig,
  enabledChecks: CheckConfig[],
): import("../lib/pr-context.js").ReviewBundleRequest {
  let need_full_diff = false;
  let need_file_contents = false;
  let need_prior_comments = false;
  let need_ticket = false;

  for (const check of enabledChecks) {
    if (check.kind === "complexity") {
      need_file_contents = true;
    }
    if (check.kind === "ai_review") {
      const data = (check.params?.data as string[] | undefined) ?? [];
      if (data.includes("diff")) need_full_diff = true;
      if (data.includes("file_content")) need_file_contents = true;
      if (data.includes("prior_comments")) need_prior_comments = true;
      if (data.includes("ticket") || data.includes("acceptance_criteria")) need_ticket = true;
    }
  }

  return {
    default_ignore: config.review.default_ignore,
    limits: config.review.limits,
    need_full_diff,
    need_file_contents,
    need_prior_comments,
    need_ticket,
  };
}

/**
 * Build changed-lines map from PR files.
 */
function buildChangedLinesMap(
  files: import("../adapters/vcs/types.js").PRFile[],
): Record<string, ReadonlyArray<{ start: number; end: number }>> {
  const result: Record<string, ReadonlyArray<{ start: number; end: number }>> = {};
  for (const f of files) {
    result[f.path] = f.changed_line_ranges;
  }
  return result;
}

/**
 * Returns true when a dependency result is considered "failed" for purposes
 * of skip_on_dependency_failure. A dep is failed when: its result is missing,
 * OR it is blocking and has any finding at or above its fail_on threshold.
 */
function depResultFailed(
  depId: string,
  dependencyResults: Record<string, CheckResult>,
  allChecks: CheckConfig[],
): boolean {
  const result = dependencyResults[depId];
  if (!result) return true;

  const depCfg = allChecks.find((c) => c.id === depId);
  if (!depCfg) return true;
  if (!depCfg.blocking) return false;

  const RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };
  const threshold = RANK[depCfg.fail_on] ?? 0;
  return result.findings.some((f) => (RANK[f.severity] ?? 0) >= threshold);
}

/**
 * Build the per-check requested_data payload based on what the check needs.
 */
async function buildCheckRequestedData(
  bundle: ReviewBundle,
  checkCfg: CheckConfig,
  dependencyResults: Record<string, CheckResult>,
  promptBody?: string,
  promptSourceId?: string,
  promptHash?: string,
): Promise<import("../lib/checks/types.js").RequestedReviewData> {
  if (checkCfg.kind === "complexity") {
    return {
      files: bundle.files
        .filter((f) => f.status !== "removed")
        .map((f) => ({
          path: f.path,
          content: bundle.file_contents?.[f.path]?.content ?? "",
          changed_line_ranges: f.changed_line_ranges,
          patch: f.patch,
        }))
        .filter((f) => f.content),
    };
  }

  if (checkCfg.kind === "ai_review") {
    const params = checkCfg.params ?? {};
    const mode = params["mode"] as string | undefined;
    const data = (params["data"] as string[] | undefined) ?? [];

    const base: Record<string, unknown> = {
      prompt_body: promptBody ?? "",
      prompt_source_id: promptSourceId ?? "",
      prompt_hash: promptHash ?? "",
      check_id: checkCfg.id,
    };

    if (checkCfg.cache?.reuse_previous_annotations !== undefined) {
      base["reuse_previous_annotations"] = checkCfg.cache.reuse_previous_annotations;
    }

    if (mode === "per_file") {
      if (data.includes("file_diff") || data.includes("file_content")) {
        base["files"] = bundle.files
          .filter((f) => f.status !== "removed")
          .map((f) => ({
            path: f.path,
            status: f.status,
            file_diff: data.includes("file_diff") ? f.patch : undefined,
            file_content: data.includes("file_content")
              ? bundle.file_contents?.[f.path]?.content
              : undefined,
            skipped: bundle.file_contents?.[f.path]?.skipped,
          }));
      }
      base["changed_files"] = bundle.files.map((f) => f.path);
      if (data.includes("prior_comments")) {
        base["prior_comments"] = bundle.prior_comments;
      }
      if (data.includes("prior_findings") && checkCfg.needs) {
        const priorFindings: Record<string, CheckResult> = {};
        for (const depId of checkCfg.needs) {
          if (dependencyResults[depId]) priorFindings[depId] = dependencyResults[depId];
        }
        base["prior_findings"] = priorFindings;
      }
    } else {
      // whole_pr mode
      if (data.includes("diff")) {
        base["diff"] = bundle.full_diff?.content;
      }
      base["changed_files"] = bundle.files.map((f) => f.path);
      if (data.includes("prior_comments")) {
        base["prior_comments"] = bundle.prior_comments;
      }
      if (data.includes("prior_findings") && checkCfg.needs) {
        const priorFindings: Record<string, CheckResult> = {};
        for (const depId of checkCfg.needs) {
          if (dependencyResults[depId]) priorFindings[depId] = dependencyResults[depId];
        }
        base["prior_findings"] = priorFindings;
      }
      if (data.includes("ticket") || data.includes("acceptance_criteria")) {
        base["ticket"] = bundle.ticket;
        base["acceptance_criteria"] = bundle.ticket?.acceptanceCriteria;
      }
    }

    return base;
  }

  return {};
}

// ---------------------------------------------------------------------------
// Main Workflow
// ---------------------------------------------------------------------------

export async function reviewWorkflow(args: ReviewWorkflowArgs): Promise<void> {
  "use workflow";
  const { logger } = await import("../lib/logger.js");
  const log = logger.child({ prNumber: args.prNumber, headSha: args.headSha });

  const { config, configHash } = await loadReviewConfigStep();

  if (!config.review.enabled) {
    log.info({}, "review_workflow_disabled");
    return;
  }

  // Fail-fast: the review pipeline only supports GitHub Check Runs / Reviews.
  // Without this guard the per-step `kind !== "github"` returns would silently
  // no-op the entire workflow on a GitLab deployment.
  const vcsKind = await getVcsKindStep();
  if (vcsKind !== "github") {
    throw new Error(`Review pipeline requires GITHUB VCS adapter; got: ${vcsKind}`);
  }

  const enabledChecks = config.review.checks.filter((c) => c.enabled);
  if (enabledChecks.length === 0) {
    log.info({}, "review_workflow_no_enabled_checks");
    return;
  }

  const bundleRequest = computeBundleRequest(config, enabledChecks);
  const bundle = await buildBundleStep(
    { owner: args.owner, repo: args.repo, prNumber: args.prNumber },
    bundleRequest,
  );

  const { mapFindingsToConclusion } = await import("../lib/checks/result.js");
  const { findingsToAnnotations, findingsToComments } = await import("../lib/check-output.js");
  const { serializeCacheManifest } = await import("../lib/checks/cache.js");

  const dependencyResults: Record<string, CheckResult> = {};

  // Pre-pass: collect IDs of checks that other enabled checks depend on.
  // Same-SHA dedupe is disabled for these because skipping them would leave
  // dependencyResults[depId] unset and any downstream check would be marked
  // failed via depResultFailed's `if (!result) return true;`. Re-running is
  // simpler than reconstructing a CheckResult from the prior Check Run output.
  const neededByOthers = new Set<string>();
  for (const c of enabledChecks) {
    if (c.needs) {
      for (const depId of c.needs) neededByOthers.add(depId);
    }
  }

  // Fetch existing review comments once (not per-check). The paginated GitHub
  // call is identical for every check that publishes comments, so hoisting
  // avoids N redundant fetches when multiple checks have `comments.enabled`.
  const anyCheckPublishesComments = enabledChecks.some((c) => c.comments?.enabled);
  const existingComments = anyCheckPublishesComments
    ? await listExistingCommentsStep({
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      })
    : [];

  for (const checkCfg of enabledChecks) {
    try {
      // --- Dependency check ---
      const depsBlocked =
        checkCfg.needs && checkCfg.needs.length > 0
          ? checkCfg.needs.some((depId) =>
              depResultFailed(depId, dependencyResults, config.review.checks),
            )
          : false;

      if (depsBlocked && checkCfg.skip_on_dependency_failure) {
        log.info({ checkId: checkCfg.id }, "review_check_dependency_skip");
        // Create a neutral/skipped check run to surface the skip
        const { checkRunRef } = await findOrCreateCheckRunStep({
          owner: args.owner,
          repo: args.repo,
          headSha: args.headSha,
          configHash,
          checkId: checkCfg.id,
          name: checkCfg.name,
        });
        await updateCheckRunStep({
          owner: args.owner,
          repo: args.repo,
          checkRunId: checkRunRef.id,
          update: {
            status: "completed",
            conclusion: "neutral",
            output: {
              title: checkCfg.name,
              summary: "Skipped: a dependency check failed.",
            },
          },
        });
        continue;
      }

      // --- Find or create check run ---
      const { checkRunRef, alreadyCompleted } = await findOrCreateCheckRunStep({
        owner: args.owner,
        repo: args.repo,
        headSha: args.headSha,
        configHash,
        checkId: checkCfg.id,
        name: checkCfg.name,
      });

      if (alreadyCompleted && !neededByOthers.has(checkCfg.id)) {
        // Same-SHA dedupe: skip re-running. We only dedupe checks that no
        // other enabled check depends on — otherwise dependencyResults[depId]
        // would be unset and downstream checks would be marked failed in
        // depResultFailed. Reconstructing a prior CheckResult from the Check
        // Run output is deferred; re-running is simpler and correct.
        log.info({ checkId: checkCfg.id }, "review_check_same_sha_dedupe");
        continue;
      }

      // --- Mark in_progress ---
      await updateCheckRunStep({
        owner: args.owner,
        repo: args.repo,
        checkRunId: checkRunRef.id,
        update: {
          status: "in_progress",
        },
      });

      // --- Load previous cache if configured ---
      let previous_cache: CheckCacheManifest | undefined;
      if (checkCfg.cache?.mode === "per_file_content_hash") {
        const cached = await listPreviousCacheStep({
          owner: args.owner,
          repo: args.repo,
          headSha: args.headSha,
          checkId: checkCfg.id,
          configHash,
        });
        previous_cache = cached ?? undefined;
      }

      // --- Load prompt for ai_review checks ---
      let promptBody: string | undefined;
      let promptSourceId: string | undefined;
      let promptHash: string | undefined;

      if (checkCfg.kind === "ai_review") {
        const promptSpec = checkCfg.params?.["prompt"] as ReviewPromptSource | undefined;
        if (promptSpec) {
          const loaded = await loadPromptStep(promptSpec);
          promptBody = loaded.body;
          promptSourceId = loaded.source_id;
          promptHash = loaded.hash;
        }
      }

      // --- Build requested_data ---
      const requested_data = await buildCheckRequestedData(
        bundle,
        checkCfg,
        dependencyResults,
        promptBody,
        promptSourceId,
        promptHash,
      );

      // --- Run check ---
      const result = await runCheckStep({
        kind: checkCfg.kind,
        params: (checkCfg.params ?? {}) as Record<string, unknown>,
        ctx: {
          pr: bundle.pr,
          requested_data,
          dependency_results: dependencyResults,
          previous_cache,
        },
      });

      dependencyResults[checkCfg.id] = result;

      // --- Map findings → annotations + overflow ---
      const { annotations, overflow_text, unanchored } = findingsToAnnotations(
        result.findings,
        {
          max_check_annotations: config.review.limits.max_check_annotations,
          max_review_comments: config.review.limits.max_review_comments,
          max_suggestions: config.review.limits.max_suggestions,
        },
      );

      // --- Copy forward annotations for cache-hit files ---
      // The check returned no fresh findings for files marked as completed
      // cache hits — those files would otherwise lose their annotations on the
      // new Check Run. Re-fetch the prior annotations from each cache-hit
      // file's `previous_check_run_id` and merge them in, respecting the
      // overall `max_check_annotations` cap.
      const mergedAnnotations = [...annotations];
      const maxAnnotations = config.review.limits.max_check_annotations;
      const cacheFiles = result.cache_manifest?.files ?? {};
      // Group cache-hit file paths by previous_check_run_id so we fetch each
      // prior run at most once.
      const pathsByPrevRunId = new Map<number, Set<string>>();
      for (const [path, entry] of Object.entries(cacheFiles)) {
        if (entry.status !== "completed") continue;
        if (typeof entry.previous_check_run_id !== "number") continue;
        let set = pathsByPrevRunId.get(entry.previous_check_run_id);
        if (!set) {
          set = new Set();
          pathsByPrevRunId.set(entry.previous_check_run_id, set);
        }
        set.add(path);
      }

      for (const [prevRunId, paths] of pathsByPrevRunId) {
        if (mergedAnnotations.length >= maxAnnotations) break;
        const prior = await listCheckRunAnnotationsStep({
          owner: args.owner,
          repo: args.repo,
          checkRunId: prevRunId,
        });
        if (prior.length === 0) {
          log.warn(
            { checkId: checkCfg.id, prevRunId },
            "review_check_copy_forward_empty",
          );
        }
        for (const ann of prior) {
          if (mergedAnnotations.length >= maxAnnotations) break;
          if (!paths.has(ann.path)) continue;
          mergedAnnotations.push(ann);
        }
      }

      // --- Build output text (cache manifest + overflow + unanchored) ---
      let outputText = "";
      if (result.cache_manifest) {
        outputText += serializeCacheManifest(result.cache_manifest);
      }
      if (overflow_text) outputText += overflow_text;
      if (unanchored.length) {
        outputText +=
          `\n\n**${unanchored.length} unanchored finding(s):**\n` +
          unanchored.map((f) => `- [${f.severity}] ${f.message}`).join("\n");
      }

      const notices = [...bundle.notices, ...result.notices];
      const noticesText =
        notices.length
          ? `**Coverage notices:**\n${notices.map((n) => `- ${n}`).join("\n")}`
          : "";
      const finalText = [noticesText, outputText].filter(Boolean).join("\n\n") || undefined;

      // --- Conclusion ---
      const conclusion = mapFindingsToConclusion(result.findings, {
        blocking: checkCfg.blocking,
        fail_on: checkCfg.fail_on,
      });

      // --- Staleness guard ---
      // Verify the PR's current head SHA still matches args.headSha. If the
      // user pushed a newer commit while we were running, skip posting (the
      // newer commit will produce its own review) and mark the Check Run as
      // neutral/superseded. A null return means the fetch failed; we proceed
      // conservatively rather than making the workflow MORE fragile.
      const currentHeadSha = await checkHeadStillCurrentStep({
        owner: args.owner,
        repo: args.repo,
        prNumber: args.prNumber,
      });
      const isStale = currentHeadSha !== null && currentHeadSha !== args.headSha;

      if (isStale) {
        log.info(
          { checkId: checkCfg.id, expected: args.headSha, current: currentHeadSha },
          "review_check_superseded",
        );
        await updateCheckRunStep({
          owner: args.owner,
          repo: args.repo,
          checkRunId: checkRunRef.id,
          update: {
            status: "completed",
            conclusion: "neutral",
            output: {
              title: checkCfg.name,
              summary: "Superseded by newer commit",
            },
          },
        });
        continue;
      }

      // --- Post review comments / suggestions if policy enabled ---
      if (checkCfg.comments?.enabled) {
        const { comments, suggestions } = findingsToComments({
          findings: result.findings,
          policy: {
            enabled: checkCfg.comments.enabled,
            severity_threshold: checkCfg.comments.severity_threshold,
            suggestions: checkCfg.comments.suggestions ?? false,
            suggestions_threshold:
              checkCfg.comments.suggestions_threshold ?? checkCfg.comments.severity_threshold,
          },
          caps: {
            max_check_annotations: config.review.limits.max_check_annotations,
            max_review_comments: config.review.limits.max_review_comments,
            max_suggestions: config.review.limits.max_suggestions,
          },
          existingComments,
          changedLines: buildChangedLinesMap(bundle.files),
        });

        if (comments.length || suggestions.length) {
          await createReviewStep({
            owner: args.owner,
            repo: args.repo,
            prNumber: args.prNumber,
            comments: [...comments, ...suggestions],
            body: result.summary,
          });
        }
      }

      // --- Complete check run ---
      await updateCheckRunStep({
        owner: args.owner,
        repo: args.repo,
        checkRunId: checkRunRef.id,
        update: {
          status: "completed",
          conclusion,
          output: {
            title: checkCfg.name,
            summary: result.summary,
            text: finalText,
            annotations: mergedAnnotations,
          },
        },
      });

      log.info(
        { checkId: checkCfg.id, conclusion, findings: result.findings.length },
        "review_check_completed",
      );
    } catch (err) {
      // Internal check error → try to publish a completed Check Run with
      // failure or neutral conclusion, then continue to the next check.
      // If the failure-publish itself throws (e.g. original error was inside
      // findOrCreateCheckRunStep due to a GitHub 403), we MUST surface the
      // original error to WDK so the run is marked failed and retried per
      // its policy — otherwise the workflow "succeeds" with no Check Run,
      // no review, and no surfaced error.
      try {
        const { checkRunRef } = await findOrCreateCheckRunStep({
          owner: args.owner,
          repo: args.repo,
          headSha: args.headSha,
          configHash,
          checkId: checkCfg.id,
          name: checkCfg.name,
        });
        await updateCheckRunStep({
          owner: args.owner,
          repo: args.repo,
          checkRunId: checkRunRef.id,
          update: {
            status: "completed",
            conclusion: checkCfg.blocking ? "failure" : "neutral",
            output: {
              title: checkCfg.name,
              summary: "Check failed internally.",
              text: (err as Error).message,
            },
          },
        });
      } catch (publishErr) {
        log.error(
          {
            checkId: checkCfg.id,
            err: (err as Error).message,
            publishErr: (publishErr as Error).message,
          },
          "review_check_publish_error_failed",
        );
        // Rethrow the ORIGINAL error so WDK marks the run failed and applies
        // its retry policy. We have no Check Run to surface the failure on.
        throw err;
      }
      log.error(
        { checkId: checkCfg.id, err: (err as Error).message },
        "review_check_internal_error",
      );
      // continue to next check
    }
  }
}
