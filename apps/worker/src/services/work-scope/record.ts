/**
 * A person's own view of the work scope record, and their own edits to it.
 *
 * The record is written on every run and, until this cluster existed, read back
 * by nothing and changed by nobody: a person who excluded a repository by
 * answering a question could never take that back, and once an exclusion left a
 * run with no repository to work on, every later run on that subject failed with
 * no recovery but a new ticket. The two entries below are that recovery, and
 * they are the only way a person reaches the record.
 *
 * One funnel, so the decision table is read once. `decideWorkScope` is what
 * decides what an edit means (which change is refused, what the trail records,
 * what a removal leaves behind); the store is what applies it under the version
 * the person read. A caller here states the subject, the version it read, and
 * the changes, and knows nothing about either.
 */
import {
  repositoryCatalogKey,
  workScopeWritePlanSchema,
  WORK_SCOPE_TRAIL_PAGE_DEFAULT,
  type RepositoryKey,
  type WorkScope,
  type WorkScopeEditRequest,
  type WorkScopeEntry,
  type WorkScopeTrailRow,
  type WorkScopeWritePlan,
} from "@shared/contracts";
import { createAuthRepository, createConnectedAuthRepository } from "../../db/repositories/auth.js";
import {
  getConnectedRepositoryCatalogStateRow,
  getRepositoryCatalogStateRow,
  listConnectedRepositoryCatalogKeys,
  listRepositoryCatalogRows,
} from "../../db/repositories/repository-catalog.js";
import {
  applyConnectedPersonWorkScopeEdit,
  applyPersonWorkScopeEdit,
  listConnectedWorkScopeTrail,
  listWorkScopeTrail,
  readConnectedWorkScope,
  readWorkScope,
} from "../../db/repositories/work-scope.js";
import type { Db } from "../../db/types.js";
import { decideWorkScope } from "../../engine/work-scope/decide.js";

/**
 * The subject kinds that carry a record at all.
 *
 * A schedule occurrence gets a new key for every tick
 * (`engine/work-scope/subject.ts`), so a record written for one would be read by
 * nobody and an edit of it would be a row a person can never see again. Refused
 * as a request error rather than written and lost.
 *
 * The one case this cannot separate is a webhook delivery: a delivery whose
 * endpoint resolved a subject id and one that fell back to the delivery id are
 * the same key shape, and only the delivery itself knew which it was. So a
 * webhook key is admitted, and the cost of the ambiguity is a row nobody reads
 * rather than a person locked out of a record that does exist.
 */
const RECORD_CARRYING_PREFIXES = ["ticket:", "pr:", "webhook:"] as const;

/** Who is editing, in the words the record and its trail will show. */
export interface WorkScopeEditor {
  /** The dashboard user behind the edit. */
  id: string;
  /** What the entry and the trail name as the decider. Omitted, the dashboard
   *  user's own name for `id` is read and used; a surface that is not a person
   *  typing in the dashboard (an MCP client) states its own label so a person
   *  reading the record later can tell the two apart. */
  label?: string;
}

/** The record and the history behind it, as one read. */
export interface WorkScopeRecordView {
  subjectKey: string;
  /** False for a subject kind that keeps no record at all and never will. The
   *  read says so and answers anyway: asking is fair, and a read cannot cause a
   *  bad write. The edit is where the same fact is a refusal. */
  carriesRecord: boolean;
  /** 0 when the subject carries no record yet, which is the version an edit of
   *  it must expect. */
  version: number;
  entries: WorkScopeEntry[];
  /** Newest first. */
  trail: WorkScopeTrailRow[];
  /** The `beforeId` of the following page, or null at the end of the trail. */
  nextTrailBeforeId: number | null;
}

export type WorkScopeEditOutcome =
  /** Written. Every selection is recorded without checking that a run can reach
   *  the repository: this path lists nothing and will not turn an edit into a
   *  provider call, so a later run may still refuse a key recorded here. That is
   *  a constant of the path rather than news about one edit, so it is stated in
   *  the route and tool documentation instead of echoed in every reply. */
  | { kind: "applied"; scope: WorkScope }
  /** Somebody (a run, or another person) wrote between the read and this edit.
   *  Read the record again: under a race `latestVersion` can equal the version
   *  that was expected. Named as `pre-pr-checks` names it, because it is the
   *  same refusal and both reach a person through the same 409. */
  | { kind: "conflict"; latestVersion: number }
  /** One `select` named a repository the catalog does not enable, so the WHOLE
   *  edit was refused and nothing was written. */
  | { kind: "not_enabled"; repositoryKeys: RepositoryKey[] }
  | { kind: "subject_carries_no_record"; subjectKey: string };

/** Everything this cluster reads and writes, so the two entries below differ in
 *  where they reach storage and in nothing else. */
interface WorkScopeRecordPersistence {
  readScope(subjectKey: string): Promise<WorkScope | null>;
  listTrail(
    subjectKey: string,
    page: { limit: number; beforeId?: number },
  ): Promise<{ rows: WorkScopeTrailRow[]; nextBeforeId: number | null }>;
  applyEdit(input: {
    subjectKey: string;
    expectedVersion: number;
    plan: WorkScopeWritePlan;
  }): Promise<
    { outcome: "applied"; scope: WorkScope } | { outcome: "conflict"; currentVersion: number }
  >;
  /** Whether the catalog decides access yet, and the keys it enables. */
  catalog(): Promise<{ activated: boolean; enabledKeys: RepositoryKey[] }>;
  editorLabel(userId: string): Promise<string>;
}

/** Explicit-db path, for pglite tests and callers that already hold a handle. */
function persistenceOf(db: Db): WorkScopeRecordPersistence {
  return {
    readScope: (subjectKey) => readWorkScope(db, subjectKey),
    listTrail: (subjectKey, page) => listWorkScopeTrail(db, { subjectKey }, page),
    applyEdit: (input) => applyPersonWorkScopeEdit(db, input),
    catalog: async () => {
      const [state, rows] = await Promise.all([
        getRepositoryCatalogStateRow(db),
        listRepositoryCatalogRows(db),
      ]);
      return catalogOf(state.activated, rows);
    },
    editorLabel: (userId) => createAuthRepository(db).dashboardUserLabel(userId),
  };
}

/** Production path: every operation resolves its own connected client. */
const connectedPersistence: WorkScopeRecordPersistence = {
  readScope: readConnectedWorkScope,
  listTrail: (subjectKey, page) => listConnectedWorkScopeTrail({ subjectKey }, page),
  applyEdit: applyConnectedPersonWorkScopeEdit,
  catalog: async () => {
    // The two key reads rather than the repository catalog cluster's own
    // loader: this edit needs the enabled keys and the activation flag and
    // nothing else, and the cluster barrel would pull the profile suggestion
    // path (and with it a model provider and the validated environment) onto a
    // request that only writes three columns.
    const [state, rows] = await Promise.all([
      getConnectedRepositoryCatalogStateRow(),
      listConnectedRepositoryCatalogKeys(),
    ]);
    return catalogOf(state.activated, rows);
  },
  editorLabel: (userId) => createConnectedAuthRepository().dashboardUserLabel(userId),
};

function catalogOf(
  activated: boolean,
  rows: Array<{ provider: string; path: string; enabled: boolean }>,
): { activated: boolean; enabledKeys: RepositoryKey[] } {
  const enabledKeys: RepositoryKey[] = [];
  for (const row of rows) {
    if (row.enabled) {
      enabledKeys.push(repositoryCatalogKey({ provider: row.provider, path: row.path }));
    }
  }
  return { activated, enabledKeys };
}

export function readWorkScopeRecord(
  db: Db,
  input: { subjectKey: string; trail?: { limit?: number; beforeId?: number } },
): Promise<WorkScopeRecordView> {
  return readRecord(persistenceOf(db), input);
}

export function readConnectedWorkScopeRecord(
  input: { subjectKey: string; trail?: { limit?: number; beforeId?: number } },
): Promise<WorkScopeRecordView> {
  return readRecord(connectedPersistence, input);
}

export function applyWorkScopeEdit(
  db: Db,
  input: { request: WorkScopeEditRequest; editor: WorkScopeEditor; now?: Date },
): Promise<WorkScopeEditOutcome> {
  return applyEdit(persistenceOf(db), input);
}

export function applyConnectedWorkScopeEdit(
  input: { request: WorkScopeEditRequest; editor: WorkScopeEditor; now?: Date },
): Promise<WorkScopeEditOutcome> {
  return applyEdit(connectedPersistence, input);
}

/** Whether this subject's record would ever be read back. Not published: both
 *  entries answer the question for every caller, and a second entry point nobody
 *  asked for is one more thing to keep in step with the list above. */
function subjectCarriesWorkScopeRecord(subjectKey: string): boolean {
  return RECORD_CARRYING_PREFIXES.some((prefix) => subjectKey.startsWith(prefix));
}

async function readRecord(
  persistence: WorkScopeRecordPersistence,
  input: { subjectKey: string; trail?: { limit?: number; beforeId?: number } },
): Promise<WorkScopeRecordView> {
  // Said, not refused. A subject kind that keeps no record answers plainly that
  // it keeps none, because a caller asking whether one exists deserves the
  // answer and a read can cause no bad write; `applyEdit` is where the same
  // fact refuses. The store is still asked, so a key of a kind that DOES carry
  // a record is never answered from this predicate alone.
  const carriesRecord = subjectCarriesWorkScopeRecord(input.subjectKey);
  const page = {
    limit: input.trail?.limit ?? WORK_SCOPE_TRAIL_PAGE_DEFAULT,
    ...(input.trail?.beforeId === undefined ? {} : { beforeId: input.trail.beforeId }),
  };
  // Both halves of one answer, and the scope first: a trail read after the
  // entries can only be newer than them, which reads as history the entries
  // have not caught up with rather than as entries ahead of their own history.
  const [scope, trail] = await Promise.all([
    persistence.readScope(input.subjectKey),
    persistence.listTrail(input.subjectKey, page),
  ]);
  return {
    subjectKey: input.subjectKey,
    carriesRecord,
    // A subject with no record answers 0 rather than null, so a caller that
    // reads and then edits never has to tell "no record" from "an empty one".
    version: scope?.version ?? 0,
    entries: scope?.entries ?? [],
    trail: trail.rows,
    nextTrailBeforeId: trail.nextBeforeId,
  };
}

async function applyEdit(
  persistence: WorkScopeRecordPersistence,
  input: { request: WorkScopeEditRequest; editor: WorkScopeEditor; now?: Date },
): Promise<WorkScopeEditOutcome> {
  const { request, editor } = input;
  if (!subjectCarriesWorkScopeRecord(request.subjectKey)) {
    return { kind: "subject_carries_no_record", subjectKey: request.subjectKey };
  }
  const [scope, catalog, label] = await Promise.all([
    persistence.readScope(request.subjectKey),
    persistence.catalog(),
    editor.label === undefined ? persistence.editorLabel(editor.id) : Promise.resolve(editor.label),
  ]);
  const decision = decideWorkScope(
    {
      scope,
      carriesRecord: true,
      catalog: {
        activated: catalog.activated,
        // While the catalog is the bridge its enabled list decides nothing and
        // the platform reaches every repository the installation exposes
        // (`repository-catalog/policy.ts`), so a person may select any of them.
        // Reading the stored list there instead would refuse a selection on the
        // one deployment state where nothing is refused.
        enabledKeys: catalog.activated
          ? catalog.enabledKeys
          : [...catalog.enabledKeys, ...request.changes.map((change) => change.repositoryKey)],
        // This path never listed the repositories, so nothing here observed that
        // one became usable and no `unusable` entry may expire on it.
        unusableKeys: null,
      },
      // A person's edit is bounded by the catalog alone. A definition pin and a
      // trigger policy bound what ONE run may take, and neither is in hand
      // outside a run; the edit event reads neither.
      pinnedProviders: null,
      pinnedKeys: null,
      policy: null,
      eventRelatedKeys: [],
      attachedKeys: null,
      selectionAnswered: false,
      // An edit decides no guess: a person selecting a repository writes an
      // entry, which is exactly what ends an omission from an answer. The
      // ticket's words decide nothing here either, so nothing dates them.
      answeredRepositoryKeys: [],
      postAnswerMentionedKeys: [],
      actor: { kind: "person", actorId: editor.id, actorLabel: label },
      now: (input.now ?? new Date()).toISOString(),
    },
    { kind: "edited", changes: request.changes },
  );
  if (decision.editRejected.length > 0) {
    // One rejected change rejects the whole edit, and the decision returns an
    // empty plan for it. Writing that plan would answer "applied" for an edit
    // that changed nothing, so the refusal is the answer.
    return {
      kind: "not_enabled",
      repositoryKeys: decision.editRejected.map((rejected) => rejected.repositoryKey),
    };
  }
  // Parsed, not trusted, exactly as a run's plan is: the plan is spelled into
  // one SQL statement as jsonb, where a shape the contract refuses lands as a
  // row nothing can read back rather than as an error anybody sees.
  const plan = workScopeWritePlanSchema.safeParse(decision.plan);
  if (!plan.success) {
    throw new Error(`work scope plan for an edit does not match the contract: ${plan.error.message}`);
  }
  const applied = await persistence.applyEdit({
    subjectKey: request.subjectKey,
    expectedVersion: request.expectedVersion,
    plan: plan.data,
  });
  return applied.outcome === "applied"
    ? { kind: "applied", scope: applied.scope }
    : { kind: "conflict", latestVersion: applied.currentVersion };
}
