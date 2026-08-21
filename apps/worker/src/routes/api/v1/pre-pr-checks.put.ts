import { createError, defineEventHandler, readBody } from "h3";
import type { PrePrCheckSaveResponse } from "@shared/contracts";
import { getDb } from "../../../db/client.js";
import { requireDashboardActor, toHttpError } from "../../../lib/auth/request-context.js";
import {
  describePrePrCheckIssues,
  repoScriptsConfigSchema,
  type PrePrCheckConfig,
  type RepoScriptsConfig,
} from "../../../pre-pr-checks/config.js";
import {
  PRE_PR_ALLOWED_ENV_VAR,
  allowedRepoEnvNames,
} from "../../../pre-pr-checks/runner.js";
import {
  dashboardUserLabel,
  savePrePrCheckConfig,
  serializePrePrCheckConfigVersion,
} from "../../../pre-pr-checks/store.js";

/**
 * Reject a save that names an environment variable the operator has not
 * allowlisted, and say which names those are.
 *
 * A courtesy, not the gate. The real enforcement is at batch start
 * (resolveRepoEnv), and it has to stay there: an allowlist shrunk after this
 * save would otherwise let a stored configuration keep forwarding a variable
 * the operator has since withdrawn. What this adds is a save-time answer, so
 * the dashboard can say "not allowlisted" while someone is typing the name
 * instead of a run failing an hour later.
 *
 * Names only, never values. This message is returned over HTTP and rendered in
 * a browser; the value the name resolves to is exactly what must not travel.
 */
function describeDisallowedEnvNames(config: RepoScriptsConfig): string | null {
  const allowed = allowedRepoEnvNames();
  // Per repository entry, not a flat set of names. A save is a whole config, so
  // the person fixing it needs to know WHERE to look, and a run that reads
  // "NPM_TOKEN is not allowlisted" against nine repositories has been told
  // nothing it can act on.
  const offenders = config.repositories
    .map((repository) => ({
      repoPath: repository.repoPath,
      names: (repository.env ?? []).filter((name) => !allowed.has(name)),
    }))
    .filter((entry) => entry.names.length > 0);
  if (offenders.length === 0) return null;
  const where = offenders
    .map((entry) => `${entry.repoPath} (${entry.names.join(", ")})`)
    .join("; ");
  // Deliberately not limited to names this save introduced. Storage is
  // verbatim, so every save asserts the whole config; re-persisting a known
  // violation because it was already there would make the allowlist advisory.
  const lead =
    allowed.size === 0
      ? `no environment variables are allowlisted on this worker, so nothing in env can be forwarded`
      : `these environment variable names are not allowlisted on this worker`;
  return (
    `Invalid config: ${lead}: ${where}. Either remove the name from the ` +
    `repository's env list, or have an operator add it to ${PRE_PR_ALLOWED_ENV_VAR} ` +
    `on the worker and redeploy. Names only are shown here; no value is ever read ` +
    `or returned by this endpoint.`
  );
}

export default defineEventHandler(async (event): Promise<PrePrCheckSaveResponse | undefined> => {
  try {
    const actor = await requireDashboardActor(event);
    const body =
      (await readBody<{ config?: PrePrCheckConfig }>(event).catch(() => null)) ?? {};
    // Validated against the repository scripts contract, which accepts both the
    // named-group shape and the legacy flat commands shape, so an editor that
    // still round-trips the old shape keeps saving.
    const submitted = body.config;
    const parsed = repoScriptsConfigSchema.safeParse(submitted);
    if (!parsed.success || submitted === undefined) {
      throw createError({
        statusCode: 400,
        statusMessage: parsed.success
          ? "Invalid config: config is required."
          : `Invalid config: ${describePrePrCheckIssues(parsed.error)}`,
      });
    }
    const envRejection = describeDisallowedEnvNames(parsed.data);
    if (envRejection) {
      throw createError({ statusCode: 400, statusMessage: envRejection });
    }
    const dbHandle = getDb();
    const saved = await savePrePrCheckConfig(dbHandle, {
      actorRole: actor.role,
      actorId: actor.userId,
      actorLabel: await dashboardUserLabel(dbHandle, actor.userId),
      // The RAW submitted shape, deliberately not parsed.data.
      //
      // repoScriptsConfigSchema normalizes on the way through: it fills setup
      // and env defaults and rewrites a legacy flat `commands` entry into
      // groups.checks. Storing that normalized value would change the bytes the
      // publication gate fingerprints, and the gate hashes the stored
      // configuration, so every recorded gate would be invalidated by a save
      // that changed nothing an operator typed. Normalization belongs at the
      // engine boundary, where runPrePrChecksWithFixes parses this value again.
      //
      config: submitted,
    });
    return { version: serializePrePrCheckConfigVersion(saved) };
  } catch (error) {
    toHttpError(error);
  }
});
