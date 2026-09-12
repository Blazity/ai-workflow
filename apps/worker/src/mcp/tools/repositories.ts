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
 * - `repositories.upsert` merges. The route defaults every field a request
 *   omits, and the dashboard compensates by sending the whole merged profile
 *   from a screen that has just read it. An agent has no screen, so this tool
 *   reads the stored profile and lays the caller's fields over it. That makes
 *   "omitted means unchanged" true here, and it is why `expectedProfileVersion`
 *   exists: the merge is against the profile THIS call read.
 * - `repositories.activate` is owner only and binds to a digest of the
 *   population the caller read, because there is no dialog to render it in.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DashboardAuthError,
  repositoryCatalogKey,
  repositoryCatalogUpsertRequestSchema,
  type RepositoryCatalogClaimedRepository,
  type RepositoryCatalogEntry,
  type RepositoryCatalogState,
  type RepositoryProfileVersion,
} from "@shared/contracts";
import {
  REPOSITORY_SUGGESTION_TIMEOUT_MS,
  RepositorySuggestionRateLimitedError,
  activateRepositoryCatalog,
  commitRepositoryImport,
  previewRepositoryImport,
  readRepositoryCatalog,
  readRepositoryCatalogEntry,
  saveRepositoryProfile,
  setRepositoryCatalogEnabled,
  suggestRepositoryProfile,
} from "../../services/repository-catalog/index.js";
import {
  readRepositoryCatalogActivationPreview,
  type RepositoryCatalogActivationPreview,
} from "../../services/repository-catalog/activation-preview.js";
import {
  countRepositoryProfileVersions,
  readRepositoryProfileVersionPage,
} from "../../services/repository-catalog/version-history.js";
import { McpPublicError, type McpToolDependencies } from "../contracts.js";
import { executeMcpMutation, executeMcpRead } from "../execute-tool.js";
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
 * A catalog refusal, as an agent reads it.
 *
 * The messages are the ones the dashboard already shows to people, so they are
 * safe to forward and they are the only actionable thing that survives: the
 * SDK's tool-error path sends the message and drops the code. Anything that is
 * not a `DashboardAuthError` is rethrown untouched, so the execute wrapper
 * turns it into INTERNAL_ERROR rather than leaking a host or a query.
 *
 * `effectNotApplied` is true on every arm, and that is a claim about this
 * cluster rather than a convenience: each of these is raised by a role check, a
 * row lookup, a validation or a provider listing, all of them before the one
 * statement that writes. A refusal raised AFTER a write would have to say so.
 */
function throwPublicCatalogError(error: unknown): never {
  if (error instanceof RepositorySuggestionRateLimitedError) {
    throw new McpPublicError(
      "RATE_LIMITED",
      `This repository has had too many suggestions in the last hour. Try again in ${error.retryAfterSeconds} seconds.`,
      true,
      error.retryAfterSeconds * 1_000,
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
 *  markdown usefully on its own. */
const PROFILE_FIELDS = [
  "description",
  "rules",
  "relationships",
  "scriptGroups",
  "gateGroups",
] as const;

type ProfileField = (typeof PROFILE_FIELDS)[number];

function changedProfileFields(
  previous: RepositoryProfileVersion | undefined,
  version: RepositoryProfileVersion,
): ProfileField[] {
  return PROFILE_FIELDS.filter((field) => {
    const before = previous === undefined ? undefined : previous[field];
    return JSON.stringify(before ?? null) !== JSON.stringify(version[field] ?? null);
  });
}

type VersionsData = {
  repositoryId: number;
  versions: (RepositoryProfileVersion & {
    /** Null when the version this one replaced is not on the page: the diff
     *  would be against a version the caller was never given. */
    changedFields: ProfileField[] | null;
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
        // has not, and the merge below would then be built on an EMPTY baseline
        // and clear the description, the rules and the script groups of a
        // repository somebody configured. Refused with the id to use instead.
        if (input.repositoryId === 0 && existing) {
          throw new McpPublicError(
            "CONFLICT",
            `${key} is already in the catalog as repositoryId ${existing.id}. Read it with repositories.get and send that id, so the fields you omit are merged from its profile instead of cleared.`,
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
        // The pre-check, not the lock. `saveRepositoryProfile` refuses a stale
        // expectation from inside the statement that writes, which is what
        // makes it atomic; this only turns the common case into a refusal that
        // names the version the caller is behind, before a merge is assembled
        // against a profile that has already moved.
        if (
          input.expectedProfileVersion !== undefined &&
          input.expectedProfileVersion !== (row?.profileVersion ?? 0)
        ) {
          throw new McpPublicError(
            "CONFLICT",
            `This repository is at profile version ${row?.profileVersion ?? 0}, not ${input.expectedProfileVersion}. Somebody saved since you read it, and the fields you omitted would be merged from a profile that no longer exists. Read repositories.get again.`,
            false,
            undefined,
            true,
          );
        }

        const current =
          row === null || row === undefined
            ? null
            : (await readRepositoryCatalogEntry(row.id)).currentProfile;
        // Omitted means unchanged. The stored profile is the baseline and the
        // caller's fields are laid over it, which is what the dashboard does
        // from a screen that has just read the same profile.
        const parsed = repositoryCatalogUpsertRequestSchema.safeParse({
          provider: input.provider,
          path: input.path,
          displayName: input.displayName ?? row?.displayName,
          defaultBranch: input.defaultBranch ?? row?.defaultBranch,
          description: input.description ?? current?.description ?? "",
          rules: input.rules ?? current?.rules ?? "",
          relationships: input.relationships ?? current?.relationships ?? [],
          scriptGroups:
            input.scriptGroups === undefined
              ? (current?.scriptGroups ?? null)
              : input.scriptGroups,
          gateGroups:
            input.gateGroups === undefined ? (current?.gateGroups ?? null) : input.gateGroups,
          // Ignored by the service for a repository that already exists, and
          // this passes it only for one it is creating, so the field can never
          // read as a second, quieter way to grant access.
          ...(row ? {} : { enabled: input.enabled ?? false }),
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
          // Read after the write, and the same list the dashboard re-renders:
          // on an activated catalog the count that matters is not this row's
          // flag but how many rows are left enabled, because taking it to zero
          // stops dispatch selecting anything at all.
          const catalog = await readRepositoryCatalog();
          return {
            repository: saved.repository,
            enabledRemaining: catalog.repositories.filter((entry) => entry.enabled).length,
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
        // Refused before the digest is even compared, and before the service is
        // reached: a catalog with nothing enabled is the one case where
        // confirming is never the right answer, so the dashboard dialog will
        // not offer the button at all. Same sentence it shows, because the
        // repair is the same one: enable a row first.
        if (preview.keeping.length === 0) {
          throw new McpPublicError(
            "VALIDATION_FAILED",
            "no repository in this catalog is enabled, so activating would stop dispatch selecting every repository at once; enable at least one first",
            false,
            undefined,
            true,
          );
        }
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
            // `reason` is required by this tool and belongs on the activation
            // state beside who ended the bridge and when. The service takes it
            // as of the catalog stage that adds the column; until this tree
            // carries that signature there is nowhere to pass it, and the MCP
            // audit row is the only record of it.
            // The digest already proves the caller read exactly this
            // population, which is what the route's acknowledged list proves
            // for a dialog. Echoing the keys the same read produced keeps the
            // service's own check as the last word: a repository that takes a
            // claim between the two reads is still refused below.
            acknowledgedRepositoryKeys: preview.claimed.map((entry) => entry.key),
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
    const envelope = await executeMcpMutation({
      deps,
      toolName: "repositories.suggest",
      targetRefs: [String(input.repositoryId)],
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
    // No trust override, and it matters more here than anywhere else on this
    // surface: the proposal is a model's text about somebody's repository and it
    // contains SHELL COMMANDS a later upsert would store for a sandbox to run.
    return mcpEnvelopeResult(envelope);
  });
}
