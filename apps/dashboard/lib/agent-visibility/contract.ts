/**
 * What the worker serves about agent briefings and clarification rounds, read
 * the way this dashboard reads it.
 *
 * THE WORKER AND THE DASHBOARD DEPLOY SEPARATELY. Every leaf record is parsed
 * with the frozen `@shared/agent-visibility` schemas through
 * `readVisibilityRecord`, one record at a time, so a newer schema version or
 * one malformed entry costs that entry, named, and never the list around it.
 * The envelopes around those records are read here by hand: they are the route
 * contract (stage 4 of docs/plans/2026-09-19-agent-visibility.md), not a
 * package shape.
 *
 * The envelopes, as the worker routes serve them:
 *
 * - `GET /api/v1/runs/{runId}/briefings?nodeId&attempt&activationScopeId&cursor`
 *   is a list page (`agentVisibilityListPageSchema`) carrying the run's own
 *   `state` (`available`, `expired`, `replay_gone`, `predates_capture`) beside
 *   `items`. The state exists because after retention a run has no attempts
 *   and no briefings at all: without it an empty list is the only thing the
 *   shape can say, and "nothing here" reads as "we lost it".
 *   Each item is one Block Attempt: `{ nodeId, attempt, activationScopeId,
 *   startedAt, iteration, sendsPrompts, briefings: [{ briefingId, overview }],
 *   missing }`, briefings in sequence order, `missing` a missing-briefing
 *   reason or null (present even when the attempt has briefings: a pass that
 *   never went out after discovery). `startedAt` orders the attempts and
 *   `iteration` (`{ loopNodeId, index }` or null) tells one turn of a loop
 *   body from the next. `sendsPrompts` is read as nullable here although the
 *   worker types it as a boolean, so a worker that cannot tell (the definition
 *   snapshot went with the replay) is rendered rather than refused.
 * - Every list page is `{ schemaVersion, cursor, items, shortened, nextCursor,
 *   total, unreadable }`, `limit` everywhere is a BYTE cap (default 49,152,
 *   maximum 524,288, and out of bounds is a 400, never a trim), and
 *   `unreadable` holds the rows the worker refused: they are in neither
 *   `items` nor `total`.
 * - `.../briefings/{briefingId}/sections`, `.../sections/{index}/parts`,
 *   `.../sections/{index}/spans`, `.../unresolved-sources`: list pages.
 * - `.../sections/{index}?offset&limit`: one section text page.
 * - `.../repository-context?cursor&limit`: `{ schemaVersion, unlistedCount,
 *   workScope, repositories }` with `repositories` a list page.
 * - `GET /api/v1/work-scope?subjectKey&rounds=true&roundsCursor`: the record as
 *   today plus `rounds`, a list page of round headers. Rounds are opt-in, so a
 *   caller from before they existed keeps its inline answer unchanged;
 *   `.../rounds/{roundId}/deliveries` and `.../effects`: list pages.
 * - `PATCH /api/v1/work-scope` answers a person's change with `{ scope }`, the
 *   whole record as it stands after it, or with 409
 *   `{ error: "version_conflict", latestVersion }` when the version the person
 *   read is no longer the one in force.
 */
import {
  AGENT_VISIBILITY_SCHEMA_VERSION,
  agentBriefingOverviewSchema,
  agentBriefingPartSchema,
  agentBriefingRedactionSpanSchema,
  agentBriefingRepositorySchema,
  agentBriefingSectionHeaderSchema,
  agentBriefingSectionPageSchema,
  agentBriefingUnresolvedSourceSchema,
  agentBriefingWorkScopeEntrySchema,
  clarificationDeliverySchema,
  clarificationEffectSchema,
  clarificationRoundHeaderSchema,
  missingBriefingReasonSchema,
  readVisibilityRecord,
  type AgentBriefingOverview,
  type AgentBriefingPart,
  type AgentBriefingRedactionSpan,
  type AgentBriefingRepository,
  type AgentBriefingSectionHeader,
  type AgentBriefingSectionPage,
  type AgentBriefingUnresolvedSource,
  type AgentBriefingWorkScopeEntry,
  type ClarificationDelivery,
  type ClarificationEffect,
  type ClarificationRoundHeader,
  type MissingBriefingReason,
  type VisibilityRead,
} from "@shared/agent-visibility";

/** A record that could not be read: written by a newer version, or broken. */
export type VisibilityProblem = Extract<VisibilityRead<unknown>, { ok: false }>;

/**
 * An entry that is not in `items` because it could not be read, named rather
 * than dropped. Two things end up here, and both mean the same to a person:
 * a stored row the WORKER refused (it sends them in `unreadable`, and its
 * `total` does not count them), and an item this DASHBOARD could not read,
 * which is what a record written by a newer worker looks like from here.
 */
interface UnreadableEntry {
  /** The collection the worker names it by ("briefings"), or null when this
   *  build is the one that could not read it. */
  rows: string | null;
  position: number;
  id: string | null;
  problem: string;
}

export interface ListPageRead<T> {
  cursor: string | null;
  nextCursor: string | null;
  total: number;
  items: T[];
  /** Entries that did not parse and are not in `items`. */
  unreadable: UnreadableEntry[];
  /** Entries whose long strings the worker shortened to fit, with full size. */
  shortened: { index: number; fullBytes: number }[];
}

/** Any of the package's schemas; the caller names what it reads to. */
type AnySchema = Parameters<typeof readVisibilityRecord>[0];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isCursor(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** A newer schema version at the top of an envelope, said the way the package
 *  says it for a record. */
function newerVersion(value: Record<string, unknown>): VisibilityProblem | null {
  const version = value.schemaVersion;
  if (typeof version === "number" && version > AGENT_VISIBILITY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: "newer_version",
      schemaVersion: version,
      message: `This record was written by a newer version of AI Workflow (schema version ${version}); this build reads version ${AGENT_VISIBILITY_SCHEMA_VERSION}.`,
    };
  }
  return null;
}

function invalid(message: string): VisibilityProblem {
  return { ok: false, reason: "invalid", message };
}

/**
 * The rows the worker itself could not read, as it lists them
 * (`{ rows, position, id, problem }`, always present and empty when every row
 * read). An entry this build cannot make sense of is kept as far as it can be
 * read rather than dropped, because the count is what a person is told.
 */
function readWorkerUnreadable(value: unknown): UnreadableEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, position) => {
    const row = isRecord(entry) ? entry : {};
    return {
      rows: typeof row.rows === "string" ? row.rows : null,
      position: isCount(row.position) ? row.position : position,
      id: typeof row.id === "string" ? row.id : null,
      problem: typeof row.problem === "string" ? row.problem : "The worker did not say what was wrong with it.",
    };
  });
}

/** Reads a list page's envelope, then each item on its own with `readItem`. */
function readList<T>(
  value: unknown,
  readItem: (item: unknown) => VisibilityRead<T>,
): VisibilityRead<ListPageRead<T>> {
  if (!isRecord(value)) return invalid("(root): expected a list page");
  const newer = newerVersion(value);
  if (newer) return newer;
  if (value.schemaVersion !== AGENT_VISIBILITY_SCHEMA_VERSION) {
    return invalid(`schemaVersion: expected ${AGENT_VISIBILITY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(value.items)) return invalid("items: expected a list");
  if (!isCursor(value.cursor) || !isCursor(value.nextCursor)) {
    return invalid("cursor: expected a string or null");
  }
  if (!isCount(value.total)) return invalid("total: expected a whole number");
  const shortened = Array.isArray(value.shortened)
    ? value.shortened.filter(
        (entry): entry is { index: number; fullBytes: number } =>
          isRecord(entry) && isCount(entry.index) && isCount(entry.fullBytes),
      )
    : [];
  // The worker's own refusals first: rows it could not read never reached
  // `items` and are not in `total` either, so a screen that counts these says
  // "one entry is not here" instead of quietly showing one fewer.
  const unreadable: UnreadableEntry[] = readWorkerUnreadable(value.unreadable);
  const items: T[] = [];
  value.items.forEach((item, position) => {
    const read = readItem(item);
    if (read.ok) items.push(read.value);
    else unreadable.push({ rows: null, position, id: null, problem: read.message });
  });
  return {
    ok: true,
    value: {
      cursor: value.cursor,
      nextCursor: value.nextCursor,
      total: value.total,
      items,
      unreadable,
      shortened,
    },
  };
}

function listOf<T>(schema: AnySchema) {
  return (value: unknown): VisibilityRead<ListPageRead<T>> =>
    readList(value, (item) => readVisibilityRecord(schema, item) as VisibilityRead<T>);
}

/** One send of a Block Attempt. The overview is read on its own, so a send
 *  written by a newer worker says so while its siblings still show. */
interface BriefingSend {
  briefingId: string;
  overview: VisibilityRead<AgentBriefingOverview>;
}

/** Everything the worker says about the sends of one Block Attempt. */
export interface AttemptBriefings {
  nodeId: string;
  attempt: number;
  activationScopeId: string;
  /** When this attempt began: what puts the attempts of a run in the order
   *  they happened rather than in node-id order. Null when not recorded. */
  startedAt: string | null;
  /** Which turn of which loop this attempt ran in, as the worker reads it off
   *  the activation scope (`root/loop:<node>:<index>`). Null outside a loop,
   *  and null for a scope spelling this worker does not know: fifty turns that
   *  differ only by an opaque id are unreadable, so it says nothing instead. */
  iteration: { loopNodeId: string; index: number } | null;
  /** Decided by the worker from the block type; false means this block never
   *  sends a prompt, and no missing reason applies. Null means the worker can
   *  no longer tell: the definition snapshot went with the replay. */
  sendsPrompts: boolean | null;
  briefings: BriefingSend[];
  missing: VisibilityRead<MissingBriefingReason> | null;
}

/** The attempts of a run, and what the run itself can still say. */
export interface AttemptBriefingsPage extends ListPageRead<AttemptBriefings> {
  /** `available`, `expired`, `replay_gone`, `predates_capture`, or a state a
   *  newer worker knows and this build does not. Null when the worker did not
   *  say, which is an older worker, not a claim about the run. */
  runState: string | null;
}

function readAttemptBriefings(value: unknown): VisibilityRead<AttemptBriefings> {
  if (!isRecord(value)) return invalid("(root): expected an attempt");
  if (typeof value.nodeId !== "string" || typeof value.activationScopeId !== "string") {
    return invalid("nodeId: expected the attempt's node and activation scope");
  }
  if (typeof value.attempt !== "number") return invalid("attempt: expected a number");
  if (value.sendsPrompts !== null && value.sendsPrompts !== undefined && typeof value.sendsPrompts !== "boolean") {
    return invalid("sendsPrompts: expected true, false or null");
  }
  if (!Array.isArray(value.briefings)) return invalid("briefings: expected a list");
  const briefings: BriefingSend[] = [];
  for (const [position, entry] of value.briefings.entries()) {
    if (!isRecord(entry) || typeof entry.briefingId !== "string" || entry.briefingId === "") {
      return invalid(`briefings.${position}.briefingId: expected a briefing id`);
    }
    briefings.push({
      briefingId: entry.briefingId,
      overview: readVisibilityRecord(agentBriefingOverviewSchema, entry.overview),
    });
  }
  return {
    ok: true,
    value: {
      nodeId: value.nodeId,
      attempt: value.attempt,
      activationScopeId: value.activationScopeId,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      iteration:
        isRecord(value.iteration) &&
        typeof value.iteration.loopNodeId === "string" &&
        value.iteration.loopNodeId !== "" &&
        isCount(value.iteration.index)
          ? { loopNodeId: value.iteration.loopNodeId, index: value.iteration.index }
          : null,
      sendsPrompts: typeof value.sendsPrompts === "boolean" ? value.sendsPrompts : null,
      briefings,
      missing:
        value.missing === null || value.missing === undefined
          ? null
          : readVisibilityRecord(missingBriefingReasonSchema, value.missing),
    },
  };
}

export function readAttemptBriefingsPage(value: unknown): VisibilityRead<AttemptBriefingsPage> {
  const page = readList(value, readAttemptBriefings);
  if (!page.ok) return page;
  // The run's state sits beside `items`, and an unknown one is carried as
  // itself: the worker deploys separately and may know states this build does
  // not. A worker that says nothing is not a run in an unknown state.
  const state = isRecord(value) && typeof value.state === "string" && value.state !== "" ? value.state : null;
  return { ok: true, value: { ...page.value, runState: state } };
}
export const readSectionHeadersPage = listOf<AgentBriefingSectionHeader>(agentBriefingSectionHeaderSchema);
export const readPartsPage = listOf<AgentBriefingPart>(agentBriefingPartSchema);
export const readSpansPage = listOf<AgentBriefingRedactionSpan>(agentBriefingRedactionSpanSchema);
export const readUnresolvedSourcesPage = listOf<AgentBriefingUnresolvedSource>(
  agentBriefingUnresolvedSourceSchema,
);
const readRepositoriesPage = listOf<AgentBriefingRepository>(agentBriefingRepositorySchema);
const readRoundHeadersPage = listOf<ClarificationRoundHeader>(clarificationRoundHeaderSchema);
export const readDeliveriesPage = listOf<ClarificationDelivery>(clarificationDeliverySchema);
export const readEffectsPage = listOf<ClarificationEffect>(clarificationEffectSchema);

export function readSectionPage(value: unknown): VisibilityRead<AgentBriefingSectionPage> {
  return readVisibilityRecord(agentBriefingSectionPageSchema, value);
}

/** The repository context document without its repositories, and the first
 *  (or a later) page of them. */
export interface RepositoryContextRead {
  unlistedCount: number;
  workScope: { version: number; leftOutKeys: string[] } | null;
  repositories: ListPageRead<AgentBriefingRepository>;
}

export function readRepositoryContextPage(value: unknown): VisibilityRead<RepositoryContextRead> {
  if (!isRecord(value)) return invalid("(root): expected a repository context");
  const newer = newerVersion(value);
  if (newer) return newer;
  if (!isCount(value.unlistedCount)) return invalid("unlistedCount: expected a whole number");
  let workScope: RepositoryContextRead["workScope"] = null;
  if (value.workScope !== null && value.workScope !== undefined) {
    const scope = value.workScope;
    if (!isRecord(scope) || !isCount(scope.version) || !Array.isArray(scope.leftOutKeys)) {
      return invalid("workScope: expected a version and the keys left out");
    }
    workScope = {
      version: scope.version,
      leftOutKeys: scope.leftOutKeys.filter((key): key is string => typeof key === "string"),
    };
  }
  const repositories = readRepositoriesPage(value.repositories);
  if (!repositories.ok) {
    return { ...repositories, message: `repositories: ${repositories.message}` };
  }
  return { ok: true, value: { unlistedCount: value.unlistedCount, workScope, repositories: repositories.value } };
}

/** The repository record of one subject, read tolerantly: an entry that does
 *  not parse is counted, never allowed to blank the record. */
export interface WorkScopeRead {
  subjectKey: string;
  carriesRecord: boolean;
  version: number;
  entries: AgentBriefingWorkScopeEntry[];
  unreadableEntries: number;
  /** Absent when the worker does not serve rounds yet. */
  rounds: VisibilityRead<ListPageRead<ClarificationRoundHeader>> | { ok: false; reason: "absent" };
}

export function readWorkScopeWithRounds(value: unknown): VisibilityRead<WorkScopeRead> {
  if (!isRecord(value)) return invalid("(root): expected a repository record");
  if (typeof value.subjectKey !== "string") return invalid("subjectKey: expected a string");
  if (typeof value.carriesRecord !== "boolean") return invalid("carriesRecord: expected true or false");
  if (!isCount(value.version)) return invalid("version: expected a whole number");
  if (!Array.isArray(value.entries)) return invalid("entries: expected a list");
  return {
    ok: true,
    value: {
      subjectKey: value.subjectKey,
      carriesRecord: value.carriesRecord,
      version: value.version,
      ...readEntries(value.entries),
      // The worker leaves the key out entirely when rounds were not asked for
      // (`work-scope.get.ts`); a null is read the same way, because neither is
      // a page of questions and "this worker does not serve them" is the only
      // honest thing either can mean.
      rounds:
        value.rounds === undefined || value.rounds === null
          ? { ok: false, reason: "absent" }
          : readRoundHeadersPage(value.rounds),
    },
  };
}

/** An entry that does not parse is counted, never allowed to blank the rest. */
function readEntries(list: readonly unknown[]): {
  entries: AgentBriefingWorkScopeEntry[];
  unreadableEntries: number;
} {
  const entries: AgentBriefingWorkScopeEntry[] = [];
  let unreadableEntries = 0;
  for (const entry of list) {
    const read = readVisibilityRecord(agentBriefingWorkScopeEntrySchema, entry);
    if (read.ok) entries.push(read.value);
    else unreadableEntries += 1;
  }
  return { entries, unreadableEntries };
}

/** The whole record after an edit, which is all the edit endpoint answers
 *  with: `{ scope }`, carrying the version now in force. */
export interface WorkScopeEditRead {
  subjectKey: string;
  version: number;
  entries: AgentBriefingWorkScopeEntry[];
  unreadableEntries: number;
}

export function readWorkScopeEdit(value: unknown): VisibilityRead<WorkScopeEditRead> {
  if (!isRecord(value) || !isRecord(value.scope)) return invalid("scope: expected the record after the change");
  const scope = value.scope;
  if (typeof scope.subjectKey !== "string") return invalid("scope.subjectKey: expected a string");
  if (!isCount(scope.version)) return invalid("scope.version: expected a whole number");
  if (!Array.isArray(scope.entries)) return invalid("scope.entries: expected a list");
  return {
    ok: true,
    value: { subjectKey: scope.subjectKey, version: scope.version, ...readEntries(scope.entries) },
  };
}
