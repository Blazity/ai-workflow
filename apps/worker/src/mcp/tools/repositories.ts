/**
 * The Repositories page, as tools.
 *
 * Everything an owner or an admin can do to the repository catalog from the
 * dashboard is one of the ten tools below, under the same rules: the same role
 * predicate, the same refusals, and a reason asked for exactly where the
 * dashboard asks for one and a column exists to keep it. A switch, an import
 * and a suggestion record no reason on either surface, so these tools take
 * none: a required field whose only destination is this transport's own audit
 * row would read as a record somebody could later go and find.
 *
 * The service cluster is the seam, never the route handler. Every call here goes
 * through `services/repository-catalog`, which is where `requireCatalogManager`,
 * the script-group name check and the activation acknowledgement live, so a tool
 * cannot reach the tables past a rule the dashboard obeys. The routes above
 * those services do status codes and nothing else, and this file does MCP error
 * codes and nothing else; that is the whole difference between the two surfaces.
 *
 * Two places where this surface is deliberately NOT a mirror of the HTTP routes,
 * both narrower:
 *
 * - `repositories.upsert` refuses a `repositoryId` of 0 for a provider and path
 *   the catalog already holds. The route reconciles it into an edit, which is
 *   safe from a screen that has just been told the repository is new and is not
 *   safe from an agent working off a stale list: the write would mint a version
 *   on somebody's configured repository under a reason written for a new one.
 * - `repositories.activate` is owner only and binds to a digest of the
 *   population the caller read, because there is no dialog to render it in.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DashboardAuthError,
  REPOSITORY_PROFILE_FIELDS,
  repositoryCatalogKey,
  repositoryCatalogUpsertRequestSchema,
  type RepositoryCatalogClaimedRepository,
  type RepositoryCatalogEntry,
  type RepositoryCatalogState,
  type RepositoryProfileField,
  type RepositoryProfileVersion,
  type SettingsSnapshot,
} from "@shared/contracts";
import {
  REPOSITORY_SUGGESTION_TIMEOUT_MS,
  RepositorySuggestionRateLimitedError,
  activateRepositoryCatalog,
  commitRepositoryImport,
  countRepositoryProfileVersions,
  joinRepositorySuggestionInFlight,
  previewRepositoryImport,
  readRepositoryCatalog,
  readRepositoryCatalogEntry,
  readRepositoryProfileVersionPage,
  RepositoryCatalogNoEnabledError,
  RepositoryProfileConflictError,
  saveRepositoryProfile,
  setRepositoryCatalogEnabled,
  suggestRepositoryProfile,
} from "../../services/repository-catalog/index.js";
import {
  readRepositoryCatalogActivationPreview,
  type RepositoryCatalogActivationPreview,
} from "../../services/repository-catalog/activation-preview.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead, mcpToolTimeoutMs } from "../execute-tool.js";
import { hashCanonicalJson } from "../sanitize-result.js";
import {
  HISTORY_PAGE_DEFAULT,
  mcpEnvelopeResult,
  registerCatalogTool,
} from "../tool-catalog.js";

/**
 * The one bound this surface raises above MCP_TOOL_TIMEOUT_MS.
 *
 * The suggestion path carries two of its own (60 s for the repository bundle,
 * `REPOSITORY_SUGGESTION_TIMEOUT_MS` for the model call) and the route it
 * mirrors documents their sum as what has to stay under the platform's 300 s
 * per invocation. The model half is the imported constant, not 90_000 typed
 * again, so raising it raises this with it instead of leaving a tool that times
 * out before the work it is waiting on does. The bundle half is restated here:
 * it belongs to `adapters/vcs/repository-profile-source.ts`, which the app tier
 * may not import, so it is one number to keep in step and it is named as such.
 */
export const REPOSITORY_PROFILE_DEADLINE_MS = 60_000;
const SUGGEST_TIMEOUT_MS = REPOSITORY_PROFILE_DEADLINE_MS + REPOSITORY_SUGGESTION_TIMEOUT_MS;

/**
 * The deadline a `repositories.suggest` call gets, whichever way it is answered.
 *
 * `executeMcpMutation` computes exactly this from `minimumTimeoutMs` for the
 * call that starts the work. The JOIN cannot go back through that wrapper: the
 * lease it holds is the very thing that refused the second call, so a second
 * `executeMcpMutation` under the same key would refuse again rather than wait.
 * The join therefore runs on the read path and brings this number with it,
 * because the read path's own signal is NOT the bound here: it carries the
 * deployment's read timeout (30 s by default), it is advisory (the operation is
 * awaited, never raced against it), and a suggestion is budgeted five times
 * that. Waiting on the deployment's read setting would time out a call that is
 * still being paid for.
 */
export function repositorySuggestionDeadlineMs(settings: SettingsSnapshot): number {
  return mcpToolTimeoutMs(settings, SUGGEST_TIMEOUT_MS);
}

/**
 * The join's refusal when the call it is waiting on outlives the deadline that
 * call was given.
 *
 * Retryable, but NOT effect-free: the call this one is waiting on is still
 * running and may still finish, so nothing here may promise the work stayed
 * undone.
 */
const JOIN_TIMEOUT_MESSAGE =
  "The suggestion this idempotency key started is still running and has now outlived the deadline it was given; it was never started twice, so wait and retry the same key, or read repositories.get for the profile as it stands";

/**
 * A catalog refusal, as an agent reads it.
 *
 * The messages are the ones the dashboard already shows to people, so they are
 * safe to forward and they are the only actionable thing that survives: the
 * SDK's tool-error path sends the message and drops the code. Anything the
 * cluster does not raise by name below is rethrown untouched, so the execute
 * wrapper turns it into INTERNAL_ERROR rather than leaking a host or a query.
 *
 * `effectNotApplied` is true on every arm, and that is a claim about this
 * cluster rather than a convenience: each of these is raised by a role check, a
 * row lookup, a validation or a provider listing, all of them before the one
 * statement that writes. A refusal raised AFTER a write would have to say so.
 */
function throwPublicCatalogError(error: unknown): never {
  if (error instanceof RepositoryCatalogNoEnabledError) {
    // The service's own sentence, forwarded rather than restated: this tool
    // used to carry a second copy of it and refuse before the service was
    // reached, which is exactly how the dashboard, this surface and the route
    // ended up with two guards and no shared check.
    throw new McpPublicError("VALIDATION_FAILED", error.message, false, undefined, true);
  }
  if (error instanceof RepositorySuggestionRateLimitedError) {
    throw new McpPublicError(
      "RATE_LIMITED",
      `This repository has had too many suggestions in the last hour. Try again in ${error.retryAfterSeconds} seconds.`,
      true,
      error.retryAfterSeconds * 1_000,
      true,
    );
  }
  if (error instanceof RepositoryProfileConflictError) {
    // The route answers this one with a BODY rather than a bare 409, because
    // the version to reload is the whole point of the refusal. MCP has no
    // payload channel on an error -- the SDK forwards the message and drops the
    // code -- so `currentVersion` is stated in the sentence instead of being
    // left for the caller to go and look up.
    throw new McpPublicError(
      "CONFLICT",
      `This repository is at profile version ${error.currentVersion}, not the expectedProfileVersion you sent. Somebody saved since you read it. Nothing was written. Read repositories.get again and send ${error.currentVersion} if you still want this save.`,
      false,
      undefined,
      // Refused by the predicate the writing statement carries, so the write
      // never happened and the idempotency key is free to reuse.
      true,
    );
  }
  if (error instanceof DashboardAuthError) {
    switch (error.statusCode) {
      case 400:
        throw new McpPublicError("VALIDATION_FAILED", error.message, false, undefined, true);
      case 403:
        throw new McpPublicError("FORBIDDEN", "Access denied", false, undefined, true);
      case 404:
        throw new McpPublicError("NOT_FOUND", error.message, false, undefined, true);
      case 409:
        throw new McpPublicError("CONFLICT", error.message, false, undefined, true);
      case 502:
        // The model call, the provider read or the proposal parse failed. The
        // service raises these with symbolic constants (`suggestion_failed`,
        // `suggestion_malformed`), never with a provider's own prose, so the
        // message is safe to forward and is the only thing that tells a caller
        // whether to retry or to stop asking. Nothing was written to the
        // profile, so the key is free; the suggestion row that records the
        // failed attempt is a cost record, not the effect this call asked for.
        throw new McpPublicError(
          "DEPENDENCY_UNAVAILABLE",
          error.message,
          true,
          undefined,
          true,
        );
      case 503:
        // Retryable and the key comes back: the import refuses the WHOLE call
        // before writing when a provider could not be listed, so nothing was
        // created and repeating it under the same key is the intended move.
        throw new McpPublicError(
          "DEPENDENCY_UNAVAILABLE",
          error.message,
          true,
          undefined,
          true,
        );
    }
  }
  throw error;
}

/**
 * Is this the idempotency store saying the first call under this key is still
 * running?
 *
 * Matched on the CODE and on retryability rather than on the sentence, which
 * belongs to `services/mcp/idempotency-store.ts` and is not this file's to
 * pin. It is deliberately loose because it is not the guard: the caller only
 * joins when the suggestion service still holds a promise for exactly this
 * repository, and rethrows otherwise.
 */
function mutationStillInProgress(error: unknown): boolean {
  return error instanceof McpPublicError && error.code === "CONFLICT" && error.retryable;
}

/**
 * Await a promise this call did not start, under a deadline of our own.
 *
 * Raced rather than aborted, because the work belongs to the caller that
 * started it: there is nothing here to cancel, and nothing here to undo. The
 * loser of the race is left running, which is correct: the original
 * call is still on the hook for its own answer and its own audit row.
 */
async function awaitWithin<T>(work: Promise<T>, deadlineMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new McpPublicError("TIMEOUT", JOIN_TIMEOUT_MESSAGE, true)),
      deadlineMs,
    );
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The `provider:owner/name` an audit row records a repository as. Lower cased
 *  by the contract's own helper, so searching the trail for a repository is not
 *  case sensitive. */
function catalogKeyOf(repository: { provider: string; path: string }): string {
  return repositoryCatalogKey(repository);
}

type ListData = {
  state: RepositoryCatalogState;
  repositories: RepositoryCatalogEntry[];
};

type EntryData = {
  repository: RepositoryCatalogEntry;
  currentProfile: RepositoryProfileVersion | null;
  versionsCount: number;
};

/** Which fields one profile version moved compared with the version it
 *  replaced. The History tab computes exactly this in the dashboard; an agent
 *  reading a version list has the same question and no way to diff two blobs of
 *  markdown usefully on its own. The field list is the contract's own, the same
 *  one an upsert reports back in `changedFields`, so a field added to a profile
 *  cannot be added to the write path and silently stay out of the history. */
function changedProfileFields(
  previous: RepositoryProfileVersion | undefined,
  version: RepositoryProfileVersion,
): RepositoryProfileField[] {
  return REPOSITORY_PROFILE_FIELDS.filter((field) => {
    const before = previous === undefined ? undefined : previous[field];
    return JSON.stringify(before ?? null) !== JSON.stringify(version[field] ?? null);
  });
}

type VersionsData = {
  repositoryId: number;
  versions: (RepositoryProfileVersion & {
    /** Null when the version this one replaced is not on the page: the diff
     *  would be against a version the caller was never given. */
    changedFields: RepositoryProfileField[] | null;
  })[];
  /** Whether versions older than the last one listed exist. */
  hasMore: boolean;
};

type ActivationPreviewData = {
  state: RepositoryCatalogState;
  keeping: { id: number; key: string; displayName: string }[];
  stopping: { id: number; key: string; displayName: string }[];
  claimed: RepositoryCatalogClaimedRepository[];
  previewDigest: string;
};

/**
 * The identity of an activation: the population the caller was shown.
 *
 * Sorted on every axis, because the digest has to be a function of the FACTS
 * and not of the order a query happened to return them in. Names and timestamps
 * are left out for the mirror-image reason `workflows.dispatch_preflight` leaves
 * a ticket title out of its digest: a display name edited between the preview
 * and the activation is cosmetic drift and must not invalidate consent, while a
 * repository entering or leaving either population must.
 */
function activationDigest(preview: RepositoryCatalogActivationPreview): string {
  const keys = (rows: readonly RepositoryCatalogEntry[]): string[] =>
    rows.map((row) => catalogKeyOf(row)).sort();
  return `sha256:${hashCanonicalJson({
    activated: preview.state.activated,
    keeping: keys(preview.keeping),
    stopping: keys(preview.stopping),
    claimed: preview.claimed
      .map((entry) => ({
        key: entry.key,
        ticketKeys: [...entry.ticketKeys].sort(),
        runIds: [...entry.runIds].sort(),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  })}`;
}

function previewData(
  preview: RepositoryCatalogActivationPreview,
): ActivationPreviewData {
  const row = (entry: RepositoryCatalogEntry) => ({
    id: entry.id,
    key: catalogKeyOf(entry),
    displayName: entry.displayName,
  });
  return {
    state: preview.state,
    keeping: preview.keeping.map(row),
    stopping: preview.stopping.map(row),
    claimed: preview.claimed,
    previewDigest: activationDigest(preview),
  };
}

/** Who the catalog records as the author of a write from this surface. The
 *  audit row already names the MCP client behind it; the profile version names
 *  the person whose token it was, because that is who a history is read for. */
function catalogActor(deps: McpToolDependencies): { role: "owner" | "admin"; id: string } {
  // The policies for every mutation in this file list only admin and owner, and
  // the gate in transport.ts refuses before a handler runs, so the narrowing is
  // a fact about the policy table rather than an assumption. The fallback keeps
  // the type honest without covering a case that can reach here.
  const role = deps.actor.role === "owner" ? "owner" : "admin";
  return { role, id: deps.actor.userId ?? deps.actor.subject };
}

export function registerRepositoryCatalogTools(
  server: McpServer,
  deps: McpToolDependencies,
): void {
  registerCatalogTool(server, "repositories.list", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "repositories.list",
      targetRefs: [],
      operation: async (): Promise<ListData> => {
        const catalog = await readRepositoryCatalog();
        return { state: catalog.state, repositories: catalog.repositories };
      },
    });
    // No trust override: a row carries a display name and the first line of a
    // description, both of them somebody's own text about their repository,
    // which is exactly what external_untrusted marks and is already the default.
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.get", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "repositories.get",
      targetRefs: [String(input.repositoryId)],
      operation: async (): Promise<EntryData> => {
        try {
          // Counted, not measured: listing a page and reporting its length
          // would answer "50 versions" for every repository with more than
          // fifty, which is exactly the repositories somebody has been
          // configuring hardest.
          const [entry, versionsCount] = await Promise.all([
            readRepositoryCatalogEntry(input.repositoryId),
            countRepositoryProfileVersions(input.repositoryId),
          ]);
          return { ...entry, versionsCount };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.list_versions", async (input) => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "repositories.list_versions",
      targetRefs: [String(input.repositoryId)],
      operation: async (): Promise<VersionsData> => {
        try {
          const limit = input.limit ?? HISTORY_PAGE_DEFAULT;
          const page = await readRepositoryProfileVersionPage({
            repositoryId: input.repositoryId,
            limit,
            before: input.before,
          });
          // Newest first, and each version compared with the one below it,
          // which is the version it replaced. The oldest row on the page has no
          // row below it: either it is the first version this repository ever
          // had, and it reports every field it recorded, or its predecessor is
          // on the next page and the honest answer is null rather than a diff
          // against a version the caller cannot see to check.
          const listed: VersionsData["versions"] = [];
          for (const [index, version] of page.versions.entries()) {
            const predecessor = page.versions[index + 1];
            listed.push({
              ...version,
              changedFields:
                predecessor === undefined && page.hasMore
                  ? null
                  : changedProfileFields(predecessor, version),
            });
          }
          return {
            repositoryId: input.repositoryId,
            versions: listed,
            hasMore: page.hasMore,
          };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.upsert", async (input) => {
    const key = catalogKeyOf({ provider: input.provider, path: input.path });
    const envelope = await executeMcpMutation({
      deps,
      toolName: "repositories.upsert",
      targetRefs: [String(input.repositoryId), key],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        const catalog = await readRepositoryCatalog();
        const existing = catalog.repositories.find(
          (entry) => catalogKeyOf(entry) === key,
        );

        // A create that would silently become an edit. The route accepts it and
        // the dashboard never sends it, because a screen that sends 0 has just
        // been told this repository is new. An agent working from a stale list
        // has not: identity is the provider and path, so the write would land
        // on the configured repository that already holds them and mint a
        // version on it under a reason written for a new one. Refused with the
        // id to use instead, rather than reconciled, exactly as a mismatched
        // non-zero id is.
        if (input.repositoryId === 0 && existing) {
          throw new McpPublicError(
            "CONFLICT",
            `${key} is already in the catalog as repositoryId ${existing.id}. Read it with repositories.get and send that id, so you are editing the profile you meant to edit.`,
            false,
            undefined,
            true,
          );
        }

        const row =
          input.repositoryId === 0
            ? null
            : catalog.repositories.find((entry) => entry.id === input.repositoryId);
        if (input.repositoryId !== 0 && !row) {
          throw new McpPublicError(
            "NOT_FOUND",
            "Unknown repository",
            false,
            undefined,
            true,
          );
        }
        if (row && catalogKeyOf(row) !== key) {
          throw new McpPublicError(
            "CONFLICT",
            `repositoryId ${input.repositoryId} is ${catalogKeyOf(row)}, not ${key}. Identity is the provider and path on this call, so one of the two is wrong; repositories.get resolves it.`,
            false,
            undefined,
            true,
          );
        }
        // Absent stays absent, all the way to the statement that writes.
        // `saveRepositoryProfile` forwards only the fields the request carried
        // and the upsert carries every other stored value forward, so there is
        // no baseline to read here and no window between reading it and
        // writing: an explicit `null` on a nullable field is how a caller
        // clears one, and an omitted field is never a clear.
        const parsed = repositoryCatalogUpsertRequestSchema.safeParse({
          provider: input.provider,
          path: input.path,
          ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
          ...(input.defaultBranch === undefined
            ? {}
            : { defaultBranch: input.defaultBranch }),
          ...(input.description === undefined ? {} : { description: input.description }),
          ...(input.rules === undefined ? {} : { rules: input.rules }),
          ...(input.relationships === undefined
            ? {}
            : { relationships: input.relationships }),
          ...(input.scriptGroups === undefined ? {} : { scriptGroups: input.scriptGroups }),
          ...(input.gateGroups === undefined ? {} : { gateGroups: input.gateGroups }),
          ...(input.batchTimeoutMinutes === undefined
            ? {}
            : { batchTimeoutMinutes: input.batchTimeoutMinutes }),
          // The concurrency token, carried by the statement itself rather than
          // checked here first: the service refuses a stale expectation from
          // inside the write, so a save that lands between this call's read of
          // the catalog and its write is caught instead of raced.
          ...(input.expectedProfileVersion === undefined
            ? {}
            : { expectedProfileVersion: input.expectedProfileVersion }),
          // Forwarded exactly as the caller sent it, and only when they sent
          // it. The service refuses it for a repository that already exists and
          // applies it to one it is creating; dropping it here instead would
          // answer a grant request with a success, which on the wire reads as a
          // grant that landed. An absent field still creates a row switched
          // off, which is the service's own default.
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          reason: input.reason,
        });
        if (!parsed.success) {
          throw new McpPublicError(
            "VALIDATION_FAILED",
            parsed.error.issues
              .map((issue) => `${issue.path.join(".") || "(body)"}: ${issue.message}`)
              .join("; "),
            false,
            undefined,
            true,
          );
        }

        try {
          const saved = await saveRepositoryProfile({
            actor: catalogActor(deps),
            request: parsed.data,
            expectedId: input.repositoryId,
          });
          return {
            repository: saved.repository,
            version: saved.version ?? saved.repository.profileVersion,
            // Both straight from the service, because the write can now decide
            // it has nothing to do: a save that asks for what the profile
            // already says mints no version, and a caller retrying a save it is
            // unsure landed has to be able to tell "already done" from "done
            // again". `changedFields` is empty whenever `unchanged` is true and
            // also for a create whose first profile sets none of these fields,
            // so it never answers that question on its own.
            unchanged: saved.unchanged ?? false,
            changedFields: saved.changedFields ?? [],
            // The commands this save stored that the suggestion path would have
            // dropped. Never a refusal (the documented uv preset is this
            // shape), and the same array the dashboard shows beside the
            // command: an agent that pasted a proposal has to be told what a
            // human reviewer would have been shown.
            warnings: saved.warnings ?? [],
          };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
      // Learned by running: a create has no id until the row exists.
      outcomeTargetRefs: (data) => [String(data.repository.id)],
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.set_enabled", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "repositories.set_enabled",
      targetRefs: [String(input.repositoryId)],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        try {
          const saved = await setRepositoryCatalogEnabled({
            actor: catalogActor(deps),
            id: input.repositoryId,
            enabled: input.enabled,
          });
          // Counted by the service, after the write, and now carried on the
          // HTTP response too: on an activated catalog the number that matters
          // is not this row's flag but how many rows are left enabled, because
          // taking it to zero stops dispatch selecting anything at all.
          return {
            repository: saved.repository,
            enabledRemaining: saved.enabledRemaining ?? 0,
          };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
      outcomeTargetRefs: (data) => [catalogKeyOf(data.repository)],
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.activate_preview", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "repositories.activate_preview",
      targetRefs: [],
      operation: async (): Promise<ActivationPreviewData> =>
        previewData(await readRepositoryCatalogActivationPreview()),
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.activate", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "repositories.activate",
      targetRefs: [],
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        const preview = await readRepositoryCatalogActivationPreview();
        // A catalog with nothing enabled is refused by the SERVICE below, which
        // is where the dashboard's refusal and this one now meet. Nothing is
        // repeated here, so the sentence an agent reads is the sentence an
        // operator reads.
        const digest = activationDigest(preview);
        if (input.previewDigest !== digest) {
          throw new McpPublicError(
            "VALIDATION_FAILED",
            // Names what moved rather than only that something did: the caller
            // cannot see the population and "read the preview again" on its own
            // is advice it can follow forever without getting anywhere.
            `previewDigest does not match the catalog as it stands now: ${preview.keeping.length} repositories enabled, ${preview.stopping.length} not, ${preview.claimed.length} of those holding a run claim. Call repositories.activate_preview, read what it returns, and send the digest it hands back.`,
            false,
            undefined,
            // Raised before the service was reached, so the key is provably
            // unspent and the corrected activation may reuse it.
            true,
          );
        }
        try {
          const outcome = await activateRepositoryCatalog({
            actor: catalogActor(deps),
            // The digest already proves the caller read exactly this
            // population, which is what the route's acknowledged list proves
            // for a dialog. Echoing the keys the same read produced keeps the
            // service's own check as the last word: a repository that takes a
            // claim between the two reads is still refused below.
            acknowledgedRepositoryKeys: preview.claimed.map((entry) => entry.key),
            // Persisted as the state row's activation_reason, the same column
            // the route writes, so the record of why the bridge ended survives
            // outside the MCP audit row.
            reason: input.reason,
          });
          if (outcome.kind === "unacknowledged") {
            throw new McpPublicError(
              "CONFLICT",
              `The catalog moved while this call was running: ${outcome.repositories
                .map((entry) => entry.key)
                .join(", ")} now hold a run claim and are not enabled. Nothing was activated. Read repositories.activate_preview again.`,
              false,
              undefined,
              true,
            );
          }
          return { state: outcome.response.state };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.import_preview", async () => {
    const envelope = await executeMcpRead({
      deps,
      toolName: "repositories.import_preview",
      targetRefs: [],
      operation: async () => await previewRepositoryImport(),
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.import", async (input) => {
    const envelope = await executeMcpMutation({
      deps,
      toolName: "repositories.import",
      // The keys are the targets of this write, and there is no other record of
      // WHICH repositories an import created: the catalog rows carry a source
      // but no actor and no reason.
      targetRefs: input.repositoryKeys.map((key) => key.trim().toLowerCase()),
      idempotencyKey: input.idempotencyKey,
      payloadHash: hashCanonicalJson(input),
      operation: async () => {
        try {
          const result = await commitRepositoryImport({
            actor: catalogActor(deps),
            request: {
              repositoryKeys: input.repositoryKeys,
              enabled: input.enabled ?? false,
            },
          });
          // The whole catalog comes back from the service because the dashboard
          // re-renders its list from it. An agent asked to import and can read
          // the list whenever it wants, so this answers the question it asked.
          return {
            imported: result.imported,
            skipped: result.skipped,
            alreadyPresent: result.alreadyPresent,
            repositoryCount: result.repositories.length,
          };
        } catch (error) {
          throwPublicCatalogError(error);
        }
      },
    });
    return mcpEnvelopeResult(envelope);
  });

  registerCatalogTool(server, "repositories.suggest", async (input) => {
    const targetRefs = [String(input.repositoryId)];
    let envelope;
    try {
      envelope = await executeMcpMutation({
        deps,
        toolName: "repositories.suggest",
        targetRefs,
        idempotencyKey: input.idempotencyKey,
        payloadHash: hashCanonicalJson(input),
        // The one call on this surface that outlives MCP_TOOL_TIMEOUT_MS by
        // design. See SUGGEST_TIMEOUT_MS.
        minimumTimeoutMs: SUGGEST_TIMEOUT_MS,
        operation: async () => {
          try {
            const proposal = await suggestRepositoryProfile({
              actor: catalogActor(deps),
              repositoryId: input.repositoryId,
            });
            return proposal;
          } catch (error) {
            throwPublicCatalogError(error);
          }
        },
      });
    } catch (error) {
      // The same key while the first call is still running. The browser's
      // second click AWAITS the answer already being paid for, and refusing an
      // agent here was the one place this surface was meaner than the screen it
      // mirrors: the caller retried into the same refusal for as long as the
      // model took. The join is the service's own in-flight promise, so nothing
      // starts a second model call; a key whose work is no longer in flight
      // still gets the ordinary refusal, because by then the answer is either
      // stored (a replay) or gone.
      const joined = mutationStillInProgress(error)
        ? joinRepositorySuggestionInFlight(input.repositoryId)
        : null;
      if (!joined) throw error;
      envelope = await executeMcpRead({
        deps,
        toolName: "repositories.suggest",
        targetRefs,
        // No new effect: this reads the result of a call that is already
        // running and already recorded, which is why it is audited as a read
        // and carries no idempotency key of its own. The deadline is the
        // SUGGESTION's, not the read path's: see repositorySuggestionDeadlineMs
        // for why the signal this operation is handed cannot be the bound.
        operation: async () => {
          try {
            return await awaitWithin(joined, repositorySuggestionDeadlineMs(deps.settings));
          } catch (joinError) {
            throwPublicCatalogError(joinError);
          }
        },
      });
    }
    // No trust override, and it matters more here than anywhere else on this
    // surface: the proposal is a model's text about somebody's repository and it
    // contains SHELL COMMANDS a later upsert would store for a sandbox to run.
    return mcpEnvelopeResult(envelope);
  });
}
