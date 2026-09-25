import {
  MEMORY_ITEMS_MAX,
  memoryTextHash,
  type MemoryKind,
  type MemoryRecalledEntry,
  type MemoryStore,
  type MemoryStoreAddition,
  type MemoryStoreAnswer,
  type MemoryStoreApplied,
  type MemoryStoreApplyRequest,
  type MemoryStoreEntry,
  type MemoryStoreFailure,
  type MemoryStoreFailureReason,
  type MemoryStoreForgetRequest,
  type MemoryStoreForgotten,
  type MemoryStoreHeld,
  type MemoryStoreHeldRequest,
  type MemoryStoreHoldings,
  type MemoryStoreRecall,
  type MemoryStoreRecallRequest,
} from "./memory";

/**
 * The check every memory store passes: the built-in store in the worker, and
 * every `integrations/*` package that serves memory. Where
 * `checkIntegrationConformance` reads a manifest, this one drives a store,
 * because what the port promises is behaviour: complete recall, complete
 * `held`, one outcome per item carrying the resulting id, forget by text,
 * refusals in the port's words.
 *
 * Each case opens a store holding nothing (`harness.open`), writes through
 * the port, reads it back right away and compares. So the store under test
 * finishes a write before it answers: an adapter over an engine that queues
 * writes runs this against a fake of that engine that does not.
 *
 * It returns every case that failed, with the first thing wrong in it, rather
 * than stopping at the first case; a case that threw or answered something
 * that is not an answer fails with that. The cases:
 *
 * - `recall_complete`: the complete set for the subjects and kinds asked, with
 *   or without a query, past `MEMORY_ITEMS_MAX`, and nothing else.
 * - `recall_ranking`: ranked only with a query, a blank one being none;
 *   scores only in a ranked answer, finite, falling, and every unscored entry
 *   after the scored ones.
 * - `recall_stored_order`: an unranked recall lists each subject and kind in
 *   the order `held` does.
 * - `held_complete`: everything of one subject and kind, past
 *   `MEMORY_ITEMS_MAX`, unranked, and nothing else.
 * - `held_order`: oldest first, by the apply that added an entry.
 * - `held_version`: a version that changes on every write, a stale
 *   `ifVersion` answered `contended` with nothing applied; or, for a store
 *   with no version, `ifVersion` refused as `rejected`.
 * - `apply_add`: one outcome per addition, `added` with an id held has, text
 *   verbatim, origin, run and ticket stamped; a second spelling of a held
 *   entry `added` anew or `already_held` by that entry's id.
 * - `apply_update`: `updated` with the id the entry has afterwards and the
 *   old id gone when it changed, origin kept, the later run stamped; an
 *   unknown id `missing`.
 * - `apply_remove`: every reason, `retired` and `reverted` included, removed
 *   and repeated in the outcome; an unknown id `missing`.
 * - `origins_round_trip`: `learned`, `derived`, `imported` and `human` come
 *   back from `held` and `recall` as written.
 * - `forget_by_text_hash`: every entry whose normalised text hashes to
 *   `textHash` goes, duplicates and other spellings included, within the
 *   kind when one is given and never outside the subject; the answer names
 *   each; a repeat removes nothing.
 * - `forget_document`: without a hash, everything of the subject and kind,
 *   or of the subject, and nothing of another subject.
 * - `list_holdings`: every subject and kind holding entries, with its count,
 *   and none holding nothing.
 * - `subjects_exact`: subjects that differ only in case are two, and a
 *   subject holding `*` or `%` is refused or matched as written.
 * - `entry_fields`: an entry carries the port's fields and no other (no
 *   trust, status, pin, placement or routing), each of its type.
 * - `refusals_typed`: an empty subject and a notebook are refused as
 *   `rejected`; an engine out of reach answers `unavailable` on every
 *   member; every refusal anywhere carries a store's code, a sentence, and a
 *   valid reason and status when present.
 * - `consolidation_declared`: traits are well formed; a store the harness can
 *   make consolidate declares it; a store that declares it does not holds
 *   near-duplicates and contradictions exactly as written; a consolidating
 *   store's `replacedBy` names another entry it holds.
 * - `protect`: every store accepts `protect` on an addition and an update;
 *   a store that declares `protects: true` keeps a protected entry intact
 *   through `harness.consolidate`.
 */
export type MemoryStoreConformanceCase =
  | "recall_complete"
  | "recall_ranking"
  | "recall_stored_order"
  | "held_complete"
  | "held_order"
  | "held_version"
  | "apply_add"
  | "apply_update"
  | "apply_remove"
  | "origins_round_trip"
  | "forget_by_text_hash"
  | "forget_document"
  | "list_holdings"
  | "subjects_exact"
  | "entry_fields"
  | "refusals_typed"
  | "consolidation_declared"
  | "protect";

export interface MemoryStoreConformanceIssue {
  readonly case: MemoryStoreConformanceCase;
  /** What is wrong and what the port asks, for the developer reading the test output. */
  readonly message: string;
}

export interface MemoryStoreConformanceHarness {
  /** A store holding nothing, of the kind under test; called once per case. */
  open(): MemoryStore | Promise<MemoryStore>;
  /**
   * The same store with its engine out of reach (a refused connection, a
   * closed database), to prove every member answers `unavailable` instead of
   * throwing.
   */
  openUnreachable(): MemoryStore | Promise<MemoryStore>;
  /**
   * For a store that consolidates: make its engine do now what it does on its
   * own (a fake of Mem0 running its Supersede over near-duplicates). Given
   * for a store that declares it consolidates, so the suite can prove what
   * `protect` does and what `replacedBy` names.
   */
  consolidate?(store: MemoryStore): Promise<void>;
}

type CaseRun = (harness: MemoryStoreConformanceHarness) => Promise<void>;

/** A case's first failure; anything else a case throws is the store's or the harness's. */
class CaseFailure extends Error {}

function fail(message: string): never {
  throw new CaseFailure(message.charAt(0).toUpperCase() + message.slice(1));
}

function quote(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

function thrown(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : quote(error);
}

/** The first few of a list, for a message that stays one line. */
function some(values: readonly string[]): string {
  const shown = values.slice(0, 3).join(", ");
  return values.length > 3 ? `${shown} and ${values.length - 3} more` : shown;
}

const REPO = "repo:conformance:acme/api";
const REPO_WEB = "repo:conformance:acme/web";
const ORG = "org:conformance:acme";

function portFact(n: number): string {
  return `Service ${n} of the API listens on port ${3000 + n}.`;
}

function portFacts(count: number): string[] {
  return Array.from({ length: count }, (_, index) => portFact(index + 1));
}

const LESSONS = [
  "Run the migrations before the seed script, or the seed fails on a missing table.",
  "A flaky login test was a race with the session cookie; wait for the cookie, not a timer.",
  "Pinning the Node version in CI stopped the lockfile churn.",
];

type Member = "recall" | "held" | "apply" | "forget" | "list";

/**
 * One call to the store, held to the rule every member keeps: it answers, and
 * the answer is `{ ok: true, ... }` or `{ ok: false, ... }`.
 */
async function ask<T>(member: Member, call: () => Promise<MemoryStoreAnswer<T>>): Promise<MemoryStoreAnswer<T>> {
  let answer: unknown;
  try {
    answer = await call();
  } catch (error) {
    fail(`${member} threw (${thrown(error)}). Every member of the port answers and none throws: a failure is { ok: false, code, detail }.`);
  }
  if (typeof answer !== "object" || answer === null || typeof (answer as { ok?: unknown }).ok !== "boolean") {
    fail(`${member} answered ${quote(answer)}, which is not an answer: every member answers { ok: true, ... } or { ok: false, code, detail }.`);
  }
  const problem = refusalProblem(answer as MemoryStoreAnswer<T>);
  if (problem !== null) fail(`${member} refused with ${quote(answer)}: ${problem}`);
  return answer as MemoryStoreAnswer<T>;
}

const STORE_FAILURES: readonly MemoryStoreFailure[] = ["unavailable", "contended", "rejected"];
const FAILURE_REASONS: readonly MemoryStoreFailureReason[] = ["key_rejected", "quota", "rate_limited", "timeout", "unreachable"];

/** What is wrong with a refusal's shape, or null for a success or a well-formed refusal. */
function refusalProblem(answer: MemoryStoreAnswer<unknown>): string | null {
  if (answer.ok) return null;
  const { code, detail, reason, status } = answer as { code: unknown; detail: unknown; reason?: unknown; status?: unknown };
  if (!STORE_FAILURES.includes(code as MemoryStoreFailure)) {
    return `a store refuses with one of ${STORE_FAILURES.join(", ")}; core's own codes and any other word are not a store's to answer.`;
  }
  if (typeof detail !== "string" || detail.trim().length === 0) {
    return "a refusal carries a sentence in detail saying what failed; core puts it where a person reads it.";
  }
  if (reason !== undefined && !FAILURE_REASONS.includes(reason as MemoryStoreFailureReason)) {
    return `reason, when present, is one of ${FAILURE_REASONS.join(", ")}.`;
  }
  if (status !== undefined && !(Number.isInteger(status) && (status as number) >= 100 && (status as number) <= 599)) {
    return "status, when present, is the HTTP status the engine answered with.";
  }
  return null;
}

/** The answer of a call that has to succeed. */
async function ok<T>(member: Member, what: string, call: () => Promise<MemoryStoreAnswer<T>>): Promise<{ readonly ok: true } & T> {
  const answer = await ask(member, call);
  if (!answer.ok) fail(`${what} was refused (${answer.code}: ${answer.detail}), where the port expects it to succeed.`);
  return answer;
}

function recall(store: MemoryStore, request: MemoryStoreRecallRequest, what: string) {
  return ok<MemoryStoreRecall>("recall", what, () => store.recall(request));
}

function held(store: MemoryStore, request: MemoryStoreHeldRequest) {
  return ok<MemoryStoreHeld>("held", `held of ${request.subject} ${request.kind}`, () => store.held(request));
}

function apply(store: MemoryStore, request: MemoryStoreApplyRequest, what: string) {
  return ok<MemoryStoreApplied>("apply", what, () => store.apply(request));
}

function forget(store: MemoryStore, request: MemoryStoreForgetRequest, what: string) {
  return ok<MemoryStoreForgotten>("forget", what, () => store.forget(request));
}

function list(store: MemoryStore, what: string) {
  return ok<MemoryStoreHoldings>("list", what, () => store.list());
}

function applying(
  subject: string,
  kind: MemoryKind,
  change: Partial<Pick<MemoryStoreApplyRequest, "add" | "update" | "remove" | "runId" | "ticketKey" | "ifVersion">>,
): MemoryStoreApplyRequest {
  return { subject, kind, add: [], update: [], remove: [], ...change };
}

/**
 * Writes `texts` as learned entries in one apply and answers their ids, by
 * position. Every later check reads right after this, so the adds have to be
 * stored now, not queued.
 */
async function seed(
  store: MemoryStore,
  subject: string,
  kind: MemoryKind,
  texts: readonly string[],
  additions: (text: string) => MemoryStoreAddition = (text) => ({ text, origin: "learned" }),
): Promise<string[]> {
  const what = `an apply adding ${texts.length} ${kind} to ${subject}`;
  const answer = await apply(store, applying(subject, kind, { add: texts.map(additions) }), what);
  const ids: string[] = [];
  for (const [index, text] of texts.entries()) {
    const outcome = answer.outcomes.find((candidate) => candidate.op === "add" && candidate.index === index);
    if (!outcome) fail(`${what} answered no outcome for add ${index} (${quote(text)}). Every item gets exactly one outcome.`);
    if (outcome.result !== "added" && outcome.result !== "already_held") {
      fail(
        `${what} answered ${quote(outcome)} for add ${index}. The suite reads right after it writes, so the store under test has to finish each add and answer its id.`,
      );
    }
    ids.push(outcome.id);
  }
  return ids;
}

/** Where an entry lives and what it is called there; ids are unique only within a subject and kind. */
function address(subject: string, kind: MemoryKind, id: string): string {
  return `${subject} ${kind} ${id}`;
}

function addressOf(entry: Pick<MemoryStoreEntry, "subject" | "kind" | "id">): string {
  return address(entry.subject, entry.kind, entry.id);
}

/** Fails unless `entries` are exactly the `expected` addresses, each once. */
function expectExactly(entries: readonly MemoryStoreEntry[], expected: readonly string[], what: string, rule: string) {
  const seen = entries.map(addressOf);
  const duplicated = seen.filter((key, index) => seen.indexOf(key) !== index);
  if (duplicated.length > 0) fail(`${what} returned an entry twice (${some(duplicated)}). ${rule}`);
  const wanted = new Set(expected);
  const missing = expected.filter((key) => !seen.includes(key));
  if (missing.length > 0) {
    fail(`${what} returned ${expected.length - missing.length} of the ${expected.length} entries held (missing ${some(missing)}). ${rule}`);
  }
  const extra = seen.filter((key) => !wanted.has(key));
  if (extra.length > 0) fail(`${what} also returned entries it was not asked for (${some(extra)}). ${rule}`);
}

const COMPLETE_RECALL =
  "Recall returns the complete set for the subjects and kinds asked, and nothing else: relevance orders it and never filters it, and cutting to a budget or a cap is core's, not the store's.";

const recallComplete: CaseRun = async (harness) => {
  const store = await harness.open();
  const factCount = MEMORY_ITEMS_MAX.facts + 5;
  const facts = await seed(store, REPO, "facts", portFacts(factCount));
  const lessons = await seed(store, REPO, "lessons", LESSONS);
  const web = await seed(store, REPO_WEB, "facts", [portFact(80), portFact(81)]);
  await seed(store, ORG, "facts", ["Every repository of the organisation deploys from its main branch."]);
  const both = [
    ...facts.map((id) => address(REPO, "facts", id)),
    ...lessons.map((id) => address(REPO, "lessons", id)),
    ...web.map((id) => address(REPO_WEB, "facts", id)),
  ];
  for (const query of [undefined, "Which port does service 7 listen on?", "zebra quasar nebula"]) {
    const asked = query === undefined ? "without a query" : `with the query ${quote(query)}`;
    const answer = await recall(store, { subjects: [REPO, REPO_WEB], kinds: ["facts", "lessons"], query }, `recall ${asked}`);
    expectExactly(answer.entries, both, `Recall of two subjects and both kinds ${asked}`, COMPLETE_RECALL);
  }
  const lessonsOnly = await recall(store, { subjects: [REPO], kinds: ["lessons"] }, "recall of one subject's lessons");
  expectExactly(
    lessonsOnly.entries,
    lessons.map((id) => address(REPO, "lessons", id)),
    "Recall of one subject's lessons",
    COMPLETE_RECALL,
  );
};

function hasScore(entry: MemoryRecalledEntry): boolean {
  return (entry as { score?: unknown }).score !== undefined;
}

const recallRanking: CaseRun = async (harness) => {
  const store = await harness.open();
  await seed(store, REPO, "facts", [
    "Deploys go out from the main branch every Tuesday.",
    "The API uses Postgres 16 for storage.",
    "Releases are tagged by a bot.",
    "The API listens on port 3000.",
  ]);
  for (const query of [undefined, "", "   "]) {
    const asked = query === undefined ? "without a query" : `with the blank query ${quote(query)}`;
    const answer = await recall(store, { subjects: [REPO], kinds: ["facts"], query }, `recall ${asked}`);
    if (answer.ranked) {
      fail(`Recall ${asked} answered ranked: true. Ranking needs a query, and a blank query is none: answer ranked: false and stored order.`);
    }
    if (answer.entries.some(hasScore)) {
      fail(`Recall ${asked} answered entries with a score. A score is present only in a ranked recall.`);
    }
  }
  const query = "Which port does the API listen on?";
  const answer = await recall(store, { subjects: [REPO], kinds: ["facts"], query }, "recall with a query");
  if (!answer.ranked) {
    if (answer.entries.some(hasScore)) {
      fail(`Recall with the query ${quote(query)} answered ranked: false and entries with a score. A score is present only in a ranked recall.`);
    }
    return;
  }
  let unscoredSeen = false;
  let previous = Number.POSITIVE_INFINITY;
  for (const entry of answer.entries) {
    if (!hasScore(entry)) {
      unscoredSeen = true;
      continue;
    }
    const score = entry.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      fail(`A ranked recall answered the score ${quote(score)} for ${quote(entry.text)}. A score is a finite number.`);
    }
    if (unscoredSeen) {
      fail(`A ranked recall put ${quote(entry.text)} (scored ${score}) after an entry without a score. Every scored entry comes first, then the ones the search did not score.`);
    }
    if (score > previous) {
      fail(`A ranked recall put ${quote(entry.text)} (scored ${score}) after an entry scored ${previous}. Scored entries come in order of falling score.`);
    }
    previous = score;
  }
};

/** The ids of one subject and kind, in the order they appear. */
function idsOf(entries: readonly MemoryStoreEntry[], subject: string, kind: MemoryKind): string[] {
  return entries.filter((entry) => entry.subject === subject && entry.kind === kind).map((entry) => entry.id);
}

const recallStoredOrder: CaseRun = async (harness) => {
  const store = await harness.open();
  for (const text of ["The API listens on port 3000.", "The API uses Postgres 16 for storage.", "Releases are tagged by a bot."]) {
    await seed(store, REPO, "facts", [text]);
  }
  for (const text of LESSONS) await seed(store, REPO, "lessons", [text]);
  await seed(store, REPO_WEB, "facts", ["The web app is built with Next.js."]);
  const answer = await recall(store, { subjects: [REPO, REPO_WEB], kinds: ["facts", "lessons"] }, "recall without a query");
  for (const kind of ["facts", "lessons"] as const) {
    const stored = (await held(store, { subject: REPO, kind })).entries.map((entry) => entry.id);
    const recalled = idsOf(answer.entries, REPO, kind);
    if (quote(recalled) !== quote(stored)) {
      fail(`Recall without a query listed ${REPO} ${kind} as ${quote(recalled)} and held lists them as ${quote(stored)}. An unranked recall keeps each subject and kind in the order held lists it.`);
    }
  }
};

const heldComplete: CaseRun = async (harness) => {
  const store = await harness.open();
  const factCount = MEMORY_ITEMS_MAX.facts + 5;
  const facts = await seed(store, REPO, "facts", portFacts(factCount));
  const lessons = await seed(store, REPO, "lessons", LESSONS);
  await seed(store, REPO_WEB, "facts", [portFact(80)]);
  const rule =
    "Held returns everything one subject holds of one kind, and nothing else, never cut: core applies the caps, and it can only apply them to what it is shown.";
  const heldFacts = await held(store, { subject: REPO, kind: "facts" });
  expectExactly(heldFacts.entries, facts.map((id) => address(REPO, "facts", id)), `Held of ${REPO} facts`, rule);
  if (heldFacts.entries.some((entry) => hasScore(entry))) {
    fail(`Held of ${REPO} facts answered entries with a score. Held is never ranked.`);
  }
  const heldLessons = await held(store, { subject: REPO, kind: "lessons" });
  expectExactly(heldLessons.entries, lessons.map((id) => address(REPO, "lessons", id)), `Held of ${REPO} lessons`, rule);
  const nothing = await held(store, { subject: ORG, kind: "facts" });
  expectExactly(nothing.entries, [], `Held of ${ORG} facts, where nothing was written,`, rule);
};

const heldOrder: CaseRun = async (harness) => {
  const store = await harness.open();
  const texts = ["The API listens on port 3000.", "The API uses Postgres 16 for storage.", "Releases are tagged by a bot."];
  const earlier: string[] = [];
  for (const text of texts) earlier.push(...(await seed(store, REPO, "facts", [text])));
  const later = await seed(store, REPO, "facts", ["Deploys go out on Tuesdays.", "Feature flags live in the settings table."]);
  const order = (await held(store, { subject: REPO, kind: "facts" })).entries.map((entry) => entry.id);
  const expected = `${quote(earlier)} followed by ${quote(later)} in either order`;
  if (quote(order.slice(0, earlier.length)) !== quote(earlier) || !later.every((id) => order.slice(earlier.length).includes(id))) {
    fail(`Held listed ${quote(order)} where it should list ${expected}. Held lists oldest first: an entry added by a later apply comes after one added by an earlier apply, which is the order core evicts by.`);
  }
};

const heldVersion: CaseRun = async (harness) => {
  const store = await harness.open();
  const add = (text: string): MemoryStoreAddition[] => [{ text, origin: "learned" }];
  const texts = (entries: readonly MemoryStoreEntry[]) => entries.map((entry) => entry.text);
  await seed(store, REPO, "facts", ["The API listens on port 3000."]);
  const first = await held(store, { subject: REPO, kind: "facts" });
  if (first.version === undefined) {
    const late = "The API uses Postgres 16 for storage.";
    const answer = await ask("apply", () => store.apply(applying(REPO, "facts", { ifVersion: "conformance-version", add: add(late) })));
    if (answer.ok || answer.code !== "rejected") {
      fail(`An apply carrying ifVersion to a store whose held answers no version answered ${answer.ok ? "ok" : answer.code}. Such a store refuses it as rejected: applying it anyway promises core a protection against a concurrent writer that it does not get.`);
    }
    if (texts((await held(store, { subject: REPO, kind: "facts" })).entries).includes(late)) {
      fail("A refused apply changed what the store holds. A refusal means nothing was applied.");
    }
    return;
  }
  if (typeof first.version !== "string" || first.version.length === 0) {
    fail(`Held answered the version ${quote(first.version)}. A version is a non-empty string, or absent when the store keeps none.`);
  }
  await apply(store, applying(REPO, "facts", { ifVersion: first.version, add: add("The API uses Postgres 16 for storage.") }), "an apply carrying the current version");
  const second = await held(store, { subject: REPO, kind: "facts" });
  if (second.version === first.version) {
    fail(`Held answered the version ${quote(first.version)} before a write and after it. The version changes whenever what the subject and kind hold changes.`);
  }
  const stale = "Releases are tagged by a bot.";
  const answer = await ask("apply", () => store.apply(applying(REPO, "facts", { ifVersion: first.version, add: add(stale) })));
  if (answer.ok || answer.code !== "contended") {
    fail(`An apply carrying a version that has since moved answered ${answer.ok ? "ok" : answer.code}. It changes nothing and answers contended, so core reads again instead of overwriting a concurrent writer.`);
  }
  const third = await held(store, { subject: REPO, kind: "facts" });
  if (texts(third.entries).includes(stale)) fail("An apply refused as contended changed what the store holds. A refusal means nothing was applied.");
  await apply(store, applying(REPO, "facts", { ifVersion: third.version, add: add(stale) }), "an apply carrying the version held answered after the refusal");
};

/**
 * One outcome per item, found by `op` and `index`; fails on a missing, a
 * repeated or an invented one.
 */
function outcomesOf(
  request: MemoryStoreApplyRequest,
  answer: MemoryStoreApplied,
  what: string,
): (op: "add" | "update" | "remove", index: number) => MemoryStoreApplied["outcomes"][number] {
  const items = [
    ...request.remove.map((_, index) => `remove ${index}`),
    ...request.update.map((_, index) => `update ${index}`),
    ...request.add.map((_, index) => `add ${index}`),
  ];
  const outcomes = Array.isArray(answer.outcomes) ? answer.outcomes : [];
  const given = outcomes.map((outcome) => `${outcome.op} ${outcome.index}`);
  const rule = "Every item gets exactly one outcome, found by op and index, and never a bare count.";
  const missing = items.filter((item) => !given.includes(item));
  if (missing.length > 0) fail(`${what} answered no outcome for ${some(missing)}. ${rule}`);
  const repeated = given.filter((item, index) => given.indexOf(item) !== index);
  if (repeated.length > 0) fail(`${what} answered more than one outcome for ${some(repeated)}. ${rule}`);
  const invented = given.filter((item) => !items.includes(item));
  if (invented.length > 0) fail(`${what} answered outcomes for items it was not given (${some(invented)}). ${rule}`);
  return (op, index) => outcomes.find((outcome) => outcome.op === op && outcome.index === index) as MemoryStoreApplied["outcomes"][number];
}

function entryWithId(entries: readonly MemoryStoreEntry[], id: string): MemoryStoreEntry | undefined {
  return entries.find((entry) => entry.id === id);
}

const RUN = "conformance-run-1";
const LATER_RUN = "conformance-run-2";
const TICKET = "CONF-1";
const LATER_TICKET = "CONF-2";
/** Punctuation, markup characters and letters outside ASCII, which a store returns byte for byte. */
const VERBATIM = "Build with `pnpm -w build` (Node 24, ≥ 2 GiB): «cache» lives in #3, not <tmp>; zażółć.";

const applyAdd: CaseRun = async (harness) => {
  const store = await harness.open();
  const request = applying(REPO, "facts", {
    runId: RUN,
    ticketKey: TICKET,
    add: [
      { text: VERBATIM, origin: "learned" },
      { text: "Deploys go out from the main branch every Tuesday.", origin: "derived" },
    ],
  });
  const what = "An apply adding two facts";
  const outcome = outcomesOf(request, await apply(store, request, what), what);
  const ids = request.add.map((addition, index) => {
    const answered = outcome("add", index);
    if (answered.result !== "added") {
      fail(`${what} answered ${quote(answered)} for ${quote(addition.text)}, which nothing held before. A finished add answers added with the entry's id.`);
    }
    if (typeof answered.id !== "string" || answered.id.length === 0) fail(`${what} answered the id ${quote(answered.id)}. An id is a non-empty string.`);
    return answered.id;
  });
  if (ids[0] === ids[1]) fail(`${what} answered one id for both (${quote(ids[0])}). Ids are unique within a subject and kind.`);
  const stored = (await held(store, { subject: REPO, kind: "facts" })).entries;
  request.add.forEach((addition, index) => {
    const id = ids[index] as string;
    const entry = entryWithId(stored, id);
    if (!entry) fail(`${what} answered the id ${quote(id)} for ${quote(addition.text)}, and held has no entry with it. An outcome carries the id the entry has in the store.`);
    if (entry.text !== addition.text) {
      fail(`${what} stored ${quote(addition.text)}, and held returns ${quote(entry.text)}. Text comes back verbatim: never reworded, trimmed or re-cased.`);
    }
    if (entry.origin !== addition.origin) fail(`${what} added ${quote(addition.text)} as ${addition.origin}, and held returns it as ${quote(entry.origin)}.`);
    if (entry.runId !== RUN || entry.ticketKey !== TICKET) {
      fail(`${what} for run ${RUN} and ticket ${TICKET} left the entry with run ${quote(entry.runId)} and ticket ${quote(entry.ticketKey)}. An apply stamps its run and ticket on what it adds.`);
    }
    if (entry.updatedAt !== undefined && !Number.isFinite(Date.parse(entry.updatedAt))) {
      fail(`Held answered updatedAt ${quote(entry.updatedAt)}, which is not a date. It is an ISO 8601 date, or absent.`);
    }
  });

  const unstamped = "Releases are tagged by a bot.";
  await seed(store, REPO, "facts", [unstamped]);
  const plain = (await held(store, { subject: REPO, kind: "facts" })).entries.find((entry) => entry.text === unstamped);
  if (plain?.runId !== undefined || plain?.ticketKey !== undefined) {
    fail(`An apply naming no run and no ticket left ${quote(unstamped)} with run ${quote(plain?.runId)} and ticket ${quote(plain?.ticketKey)}. Both are absent when the apply that wrote the text named none.`);
  }

  const spelling = "deploys go out from the main branch every tuesday";
  const again = applying(REPO, "facts", { add: [{ text: spelling, origin: "learned" }] });
  const before = (await held(store, { subject: REPO, kind: "facts" })).entries.length;
  const second = outcomesOf(again, await apply(store, again, "An apply adding a second spelling of a held fact"), "An apply adding a second spelling of a held fact")("add", 0);
  const after = (await held(store, { subject: REPO, kind: "facts" })).entries;
  if (second.result === "already_held") {
    if (second.id !== ids[1] || after.length !== before) {
      fail(`An add answered already_held with the id ${quote(second.id)}, and the store now holds ${after.length} entries where it held ${before}. already_held names the entry that has the same normalised text, ${quote(ids[1])}, and writes nothing.`);
    }
  } else if (second.result === "added") {
    if (ids.includes(second.id) || entryWithId(after, second.id)?.text !== spelling) {
      fail(`An add of a second spelling answered added with the id ${quote(second.id)}, which is not a new entry holding ${quote(spelling)}. A store that holds both spellings gives the second its own id.`);
    }
  } else {
    fail(`An add of a second spelling of a held fact answered ${quote(second)}. It is added (a store that can hold both) or already_held (a store whose ids follow the text).`);
  }

  const empty = applying(REPO, "facts", {});
  outcomesOf(empty, await apply(store, empty, "An apply with nothing in it"), "An apply with nothing in it");
};

const applyUpdate: CaseRun = async (harness) => {
  const store = await harness.open();
  const [learned, derived] = await seed(
    store,
    REPO,
    "facts",
    ["The API listens on port 3000.", "The API uses Postgres 15 for storage."],
    (text) => ({ text, origin: text.includes("Postgres") ? "derived" : "learned" }),
  );
  const changes = [
    { id: learned as string, text: "The API listens on port 8080.", origin: "learned" },
    { id: derived as string, text: "The API uses Postgres 16 for storage.", origin: "derived" },
  ];
  for (const change of changes) {
    const request = applying(REPO, "facts", { runId: LATER_RUN, ticketKey: LATER_TICKET, update: [{ id: change.id, text: change.text }] });
    const what = `An update of ${quote(change.id)} to ${quote(change.text)}`;
    const outcome = outcomesOf(request, await apply(store, request, what), what)("update", 0);
    if (outcome.result !== "updated" || outcome.previousId !== change.id || typeof outcome.id !== "string" || outcome.id.length === 0) {
      fail(`${what} answered ${quote(outcome)}. An update of a held entry answers updated, with previousId the id it was given and id the one the entry has now.`);
    }
    const stored = (await held(store, { subject: REPO, kind: "facts" })).entries;
    const entry = entryWithId(stored, outcome.id);
    if (!entry || entry.text !== change.text) {
      fail(`${what} answered the id ${quote(outcome.id)}, and held has ${entry ? `it with the text ${quote(entry.text)}` : "no entry with it"}. The outcome carries the id the entry has AFTER the update, which may differ from the one it had.`);
    }
    if (outcome.id !== change.id && entryWithId(stored, change.id)) {
      fail(`${what} gave the entry the new id ${quote(outcome.id)}, and held still has an entry under the old one. When the id changes, the old id is gone.`);
    }
    if (entry.origin !== change.origin) fail(`${what} turned a ${change.origin} entry into ${quote(entry.origin)}. An update keeps the entry's origin.`);
    if (entry.runId !== LATER_RUN || entry.ticketKey !== LATER_TICKET) {
      fail(`${what} for run ${LATER_RUN} and ticket ${LATER_TICKET} left the entry with run ${quote(entry.runId)} and ticket ${quote(entry.ticketKey)}. An update stamps its run and ticket as the entry's last writer.`);
    }
    if (stored.length !== 2) fail(`${what} left ${stored.length} entries where there were 2. An update replaces one entry's text and adds nothing.`);
  }

  const before = (await held(store, { subject: REPO, kind: "facts" })).entries.map((entry) => `${entry.id} ${entry.text}`);
  const unknown = "conformance-id-nobody-holds";
  const request = applying(REPO, "facts", { update: [{ id: unknown, text: "Anything." }] });
  const what = "An update of an id nobody holds";
  const outcome = outcomesOf(request, await apply(store, request, what), what)("update", 0);
  if (outcome.result !== "missing" || outcome.id !== unknown) {
    fail(`${what} answered ${quote(outcome)}. It answers missing with that id: another writer removed it first, which is not a failure.`);
  }
  const after = (await held(store, { subject: REPO, kind: "facts" })).entries.map((entry) => `${entry.id} ${entry.text}`);
  if (quote(after) !== quote(before)) fail(`${what} changed what the store holds. A missing item changes nothing.`);
};

const REMOVAL_REASONS = ["refuted", "cap", "forgotten", "retired", "reverted"] as const;

const applyRemove: CaseRun = async (harness) => {
  const store = await harness.open();
  const keeper = "The API listens on port 3000.";
  const ids = await seed(store, REPO, "facts", [keeper, ...REMOVAL_REASONS.map((reason) => `An entry removed as ${reason}.`)]);
  const remove = REMOVAL_REASONS.map((reason, index) => ({ id: ids[index + 1] as string, reason }));
  const request = applying(REPO, "facts", { remove });
  const what = "An apply removing one entry for each reason";
  const outcome = outcomesOf(request, await apply(store, request, what), what);
  remove.forEach((removal, index) => {
    const answered = outcome("remove", index);
    if (answered.result !== "removed" || answered.id !== removal.id || answered.reason !== removal.reason) {
      fail(`${what} answered ${quote(answered)} for the removal of ${quote(removal.id)} as ${removal.reason}. A removal answers removed with the id and the reason it was given; ${REMOVAL_REASONS.join(", ")} are all reasons.`);
    }
  });
  const left = (await held(store, { subject: REPO, kind: "facts" })).entries;
  if (left.length !== 1 || left[0]?.id !== ids[0]) {
    fail(`After removing five entries held has ${quote(left.map((entry) => entry.text))}, where only ${quote(keeper)} should be left.`);
  }
  const missing = applying(REPO, "facts", { remove: [{ id: "conformance-id-nobody-holds", reason: "cap" }] });
  const gone = outcomesOf(missing, await apply(store, missing, "A removal of an id nobody holds"), "A removal of an id nobody holds")("remove", 0);
  if (gone.result !== "missing" || gone.id !== "conformance-id-nobody-holds") {
    fail(`A removal of an id nobody holds answered ${quote(gone)}. It answers missing with that id, which is not a failure.`);
  }
};

const ORIGINS = ["learned", "derived", "imported", "human"] as const;

const originsRoundTrip: CaseRun = async (harness) => {
  const store = await harness.open();
  const texts = ORIGINS.map((origin) => `An entry whose origin is ${origin}.`);
  const ids = await seed(store, REPO, "facts", texts, (text) => ({
    text,
    origin: ORIGINS.find((origin) => text.endsWith(`${origin}.`)) ?? "learned",
  }));
  const reads = [
    ["held", (await held(store, { subject: REPO, kind: "facts" })).entries],
    ["recall", (await recall(store, { subjects: [REPO], kinds: ["facts"] }, "recall without a query")).entries],
  ] as const;
  for (const [member, entries] of reads) {
    ORIGINS.forEach((origin, index) => {
      const entry = entryWithId(entries, ids[index] as string);
      if (entry?.origin !== origin) {
        fail(`An entry added as ${origin} comes back from ${member} as ${quote(entry?.origin)}. Every origin (${ORIGINS.join(", ")}) is stored and returned as given.`);
      }
    });
  }
};

/** Fails unless `removed` names exactly `expected` (`kind id` pairs). */
function expectRemoved(removed: MemoryStoreForgotten["removed"], expected: readonly string[], what: string) {
  const named = (Array.isArray(removed) ? removed : []).map((entry) => `${entry.kind} ${entry.id}`);
  if (quote([...named].sort()) !== quote([...expected].sort())) {
    fail(`${what} answered removed ${quote(named)}, where the entries it had to remove were ${quote(expected)}. Forget names every entry it removed, by id and kind, and nothing else.`);
  }
}

async function matching(store: MemoryStore, subject: string, kind: MemoryKind, hash: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of (await held(store, { subject, kind })).entries) {
    if ((await memoryTextHash(entry.text)) === hash) found.push(`${kind} ${entry.id}`);
  }
  return found;
}

const forgetByTextHash: CaseRun = async (harness) => {
  const store = await harness.open();
  const target = "Use pnpm for installs.";
  const other = "Use npm for publishing.";
  await seed(store, REPO, "facts", [target, other]);
  // A second spelling from a later run: a store that holds duplicates now has two.
  await seed(store, REPO, "facts", ["use pnpm for installs"]);
  await seed(store, REPO, "lessons", ["USE PNPM FOR INSTALLS"]);
  await seed(store, REPO_WEB, "facts", [target]);
  const hash = await memoryTextHash(target);
  const facts = await matching(store, REPO, "facts", hash);
  const lessons = await matching(store, REPO, "lessons", hash);
  const rule = `Forget matches by memoryTextHash, the hash of the normalised text, and removes every entry of the subject (and kind, when given) that has it.`;

  const first = `Forget of ${quote(target)} in ${REPO} facts`;
  expectRemoved((await forget(store, { subject: REPO, kind: "facts", textHash: hash }, first)).removed, facts, first);
  const leftFacts = (await held(store, { subject: REPO, kind: "facts" })).entries.map((entry) => entry.text);
  if (quote(leftFacts) !== quote([other])) fail(`After ${first} held has ${quote(leftFacts)}, where only ${quote(other)} should be left. ${rule}`);
  if ((await held(store, { subject: REPO, kind: "lessons" })).entries.length !== lessons.length) {
    fail(`${first} also touched ${REPO} lessons. With a kind, forget stays in that kind.`);
  }

  const second = `Forget of ${quote(target)} in ${REPO}, both kinds`;
  expectRemoved((await forget(store, { subject: REPO, textHash: hash }, second)).removed, lessons, second);
  if ((await held(store, { subject: REPO, kind: "lessons" })).entries.length > 0) fail(`After ${second} ${REPO} lessons still hold it. ${rule}`);
  if ((await held(store, { subject: REPO_WEB, kind: "facts" })).entries.length !== 1) {
    fail(`Forgetting in ${REPO} removed the same text from ${REPO_WEB}. Forget stays in the subject it was given.`);
  }
  const third = `A repeated forget of ${quote(target)} in ${REPO}`;
  expectRemoved((await forget(store, { subject: REPO, textHash: hash }, third)).removed, [], third);
};

const forgetDocument: CaseRun = async (harness) => {
  const store = await harness.open();
  const facts = await seed(store, REPO, "facts", ["The API listens on port 3000.", "The API uses Postgres 16 for storage."]);
  const lessons = await seed(store, REPO, "lessons", LESSONS.slice(0, 2));
  await seed(store, REPO_WEB, "facts", ["The web app is built with Next.js."]);
  const first = `Forget of ${REPO} lessons`;
  expectRemoved((await forget(store, { subject: REPO, kind: "lessons" }, first)).removed, lessons.map((id) => `lessons ${id}`), first);
  if ((await held(store, { subject: REPO, kind: "facts" })).entries.length !== facts.length) fail(`${first} also removed facts. With a kind, forget stays in that kind.`);
  const [lesson] = await seed(store, REPO, "lessons", [LESSONS[2] as string]);
  const second = `Forget of everything ${REPO} holds`;
  expectRemoved(
    (await forget(store, { subject: REPO }, second)).removed,
    [...facts.map((id) => `facts ${id}`), `lessons ${lesson}`],
    second,
  );
  for (const kind of ["facts", "lessons"] as const) {
    if ((await held(store, { subject: REPO, kind })).entries.length > 0) fail(`After ${second} ${REPO} ${kind} still hold entries. Without a text hash forget removes every entry of the subject (and kind).`);
  }
  if ((await held(store, { subject: REPO_WEB, kind: "facts" })).entries.length !== 1) fail(`${second} removed ${REPO_WEB} facts. Forget stays in the subject it was given.`);
};

const listHoldings: CaseRun = async (harness) => {
  const store = await harness.open();
  const empty = await list(store, "list of a store holding nothing");
  if (!Array.isArray(empty.holdings) || empty.holdings.length > 0) {
    fail(`List of a store holding nothing answered ${quote(empty.holdings)}. Only a subject and kind holding entries is listed.`);
  }
  await seed(store, REPO, "facts", ["The API listens on port 3000.", "The API uses Postgres 16 for storage."]);
  const [lesson] = await seed(store, REPO, "lessons", [LESSONS[0] as string]);
  await seed(store, REPO_WEB, "facts", [portFact(80), portFact(81), portFact(82)]);
  const check = async (expected: Record<string, number>, what: string) => {
    const answer = await list(store, what);
    const seen = new Set<string>();
    for (const holding of answer.holdings) {
      const key = `${holding.subject} ${holding.kind}`;
      if (seen.has(key)) fail(`${what} listed ${key} twice.`);
      seen.add(key);
      if (expected[key] === undefined) fail(`${what} listed ${key} (${holding.entries} entries), which holds nothing. Only a subject and kind holding entries is listed.`);
      if (holding.entries !== expected[key]) fail(`${what} counted ${holding.entries} entries under ${key}, which holds ${expected[key]}.`);
      if (holding.updatedAt !== undefined && !Number.isFinite(Date.parse(holding.updatedAt))) fail(`${what} answered updatedAt ${quote(holding.updatedAt)}, which is not a date.`);
    }
    const unlisted = Object.keys(expected).filter((key) => !seen.has(key));
    if (answer.complete === true && unlisted.length > 0) {
      fail(`${what} answered complete: true and left out ${some(unlisted)}. A list that says it is complete lists every subject and kind holding entries.`);
    }
    if (typeof answer.complete !== "boolean") fail(`${what} answered complete ${quote(answer.complete)}, which is not true or false.`);
  };
  await check({ [`${REPO} facts`]: 2, [`${REPO} lessons`]: 1, [`${REPO_WEB} facts`]: 3 }, "List of a store holding three subjects and kinds");
  await apply(store, applying(REPO, "lessons", { remove: [{ id: lesson as string, reason: "refuted" }] }), `an apply removing ${REPO}'s only lesson`);
  await check({ [`${REPO} facts`]: 2, [`${REPO_WEB} facts`]: 3 }, `List after ${REPO}'s only lesson was removed`);
};

/** Subjects that read as patterns to an engine that filters by pattern. */
const PATTERN_SUBJECTS = ["repo:conformance:*", "repo:conformance:%", "*"];

const subjectsExact: CaseRun = async (harness) => {
  const store = await harness.open();
  const upper = "repo:conformance:Acme/API";
  const [upperId] = await seed(store, upper, "facts", ["The upper-case repository deploys on Mondays."]);
  const [lowerId] = await seed(store, REPO, "facts", ["The lower-case repository deploys on Fridays."]);
  const unchanged = async (after: string) => {
    for (const [subject, id] of [[upper, upperId], [REPO, lowerId]] as const) {
      const entries = (await held(store, { subject, kind: "facts" })).entries;
      if (entries.length !== 1 || entries[0]?.id !== id) {
        fail(`${after}, held of ${subject} facts answered ${quote(entries.map((entry) => `${entry.subject} ${entry.text}`))}. A subject is matched exactly: ${quote(upper)} and ${quote(REPO)} differ only in case and are two subjects.`);
      }
    }
  };
  await unchanged("After writing one fact to each of two subjects that differ only in case");
  const rule = "A pattern character in a subject is a character: the store matches it exactly (and holds nothing under it) or refuses the call as rejected. It never reads it as every subject.";
  for (const pattern of PATTERN_SUBJECTS) {
    const reads = [
      ["held", await ask("held", () => store.held({ subject: pattern, kind: "facts" }))],
      ["recall", await ask("recall", () => store.recall({ subjects: [pattern], kinds: ["facts"] }))],
      ["forget", await ask("forget", () => store.forget({ subject: pattern }))],
    ] as const;
    for (const [member, answer] of reads) {
      if (!answer.ok) {
        if (answer.code !== "rejected") fail(`${member} of the subject ${quote(pattern)} answered ${answer.code}. ${rule}`);
        continue;
      }
      const found = "entries" in answer ? answer.entries : "removed" in answer ? answer.removed : [];
      if (found.length > 0) fail(`${member} of the subject ${quote(pattern)} answered ${found.length} entries of other subjects. ${rule}`);
    }
  }
  await unchanged("After held, recall and forget of pattern subjects");
};

/**
 * The fields an entry may carry, held equal to `MemoryStoreEntry` by the
 * compiler: a field added to the entry without a decision here fails the
 * typecheck.
 */
const ENTRY_FIELDS = {
  id: true,
  subject: true,
  kind: true,
  text: true,
  origin: true,
  runId: true,
  ticketKey: true,
  updatedAt: true,
  replacedBy: true,
} as const satisfies Record<keyof MemoryStoreEntry, true>;

/** Words a store might carry that name core's policy, for a message that says whose they are. */
const CORE_FIELDS = new Set(["trust", "status", "statusReason", "pinned", "pin", "topic", "area", "module", "anchors", "routing", "disputes"]);

const KINDS: ReadonlySet<string> = new Set<MemoryKind>(["facts", "lessons"]);

function entryProblem(entry: MemoryRecalledEntry, member: "held" | "recall"): string | null {
  for (const field of Object.keys(entry)) {
    if (Object.hasOwn(ENTRY_FIELDS, field) || (member === "recall" && field === "score")) continue;
    if (CORE_FIELDS.has(field)) {
      return `carries ${quote(field)}, which is core's: a store holds the text, its origin and who last wrote it, and core keeps trust, pins, status, placement and routing in its own record.`;
    }
    return `carries ${quote(field)}, which the port does not have (${Object.keys(ENTRY_FIELDS).join(", ")}${member === "recall" ? ", and score" : ""}).`;
  }
  if (typeof entry.id !== "string" || entry.id.length === 0) return `has the id ${quote(entry.id)}; an id is a non-empty string.`;
  if (typeof entry.subject !== "string" || typeof entry.text !== "string") return "has a subject or a text that is not a string.";
  if (!KINDS.has(entry.kind)) return `has the kind ${quote(entry.kind)}; a kind is facts or lessons.`;
  if (!ORIGINS.includes(entry.origin)) return `has the origin ${quote(entry.origin)}; an origin is one of ${ORIGINS.join(", ")}.`;
  for (const field of ["runId", "ticketKey", "updatedAt", "replacedBy"] as const) {
    if (entry[field] !== undefined && typeof entry[field] !== "string") return `has ${field} ${quote(entry[field])}, which is not a string.`;
  }
  return null;
}

const entryFields: CaseRun = async (harness) => {
  const store = await harness.open();
  await apply(
    store,
    applying(REPO, "facts", {
      runId: RUN,
      ticketKey: TICKET,
      add: [
        { text: "The API listens on port 3000.", origin: "learned" },
        { text: "Deploys need a second reviewer.", origin: "human" },
      ],
    }),
    "an apply adding two facts",
  );
  const reads = [
    ["held", (await held(store, { subject: REPO, kind: "facts" })).entries],
    ["recall", (await recall(store, { subjects: [REPO], kinds: ["facts"] }, "recall without a query")).entries],
    ["recall", (await recall(store, { subjects: [REPO], kinds: ["facts"], query: "Which port?" }, "recall with a query")).entries],
  ] as const;
  for (const [member, entries] of reads) {
    for (const entry of entries) {
      const problem = entryProblem(entry, member);
      if (problem !== null) fail(`An entry ${member} returned (${quote(entry.text)}) ${problem}`);
    }
  }
};

const refusalsTyped: CaseRun = async (harness) => {
  const store = await harness.open();
  const addition: MemoryStoreAddition[] = [{ text: "The API listens on port 3000.", origin: "learned" }];
  const notebook = "notebook" as MemoryKind;
  const emptySubject = "An empty subject addresses every subject to an engine that filters, so it is refused as rejected.";
  const notAKind = "A kind is facts or lessons; a notebook never reaches this port, so it is refused as rejected.";
  const refusals = [
    ["Recall of the empty subject", "recall", emptySubject, () => store.recall({ subjects: [""], kinds: ["facts"] })],
    ["Held of the empty subject", "held", emptySubject, () => store.held({ subject: "", kind: "facts" })],
    ["An apply to the empty subject", "apply", emptySubject, () => store.apply(applying("", "facts", { add: addition }))],
    ["Forget of the empty subject", "forget", emptySubject, () => store.forget({ subject: "" })],
    ["Held of a notebook", "held", notAKind, () => store.held({ subject: REPO, kind: notebook })],
    ["An apply to a notebook", "apply", notAKind, () => store.apply(applying(REPO, notebook, { add: addition }))],
  ] as const;
  for (const [what, member, rule, call] of refusals) {
    const answer = await ask<unknown>(member, call);
    if (answer.ok || answer.code !== "rejected") fail(`${what} answered ${answer.ok ? "ok" : answer.code}. ${rule}`);
  }
  const listing = await list(store, "list after refused writes");
  if (listing.holdings.length > 0) fail(`Refused applies left ${quote(listing.holdings)} in the store. A refusal means nothing was applied.`);

  const unreachable = await harness.openUnreachable();
  const calls = [
    ["recall", () => unreachable.recall({ subjects: [REPO], kinds: ["facts"] })],
    ["held", () => unreachable.held({ subject: REPO, kind: "facts" })],
    ["apply", () => unreachable.apply(applying(REPO, "facts", { add: addition }))],
    ["forget", () => unreachable.forget({ subject: REPO })],
    ["list", () => unreachable.list()],
  ] as const;
  for (const [member, call] of calls) {
    const answer = await ask<unknown>(member, call);
    if (answer.ok || answer.code !== "unavailable") {
      fail(`${member} on a store whose engine cannot be reached answered ${answer.ok ? "ok" : answer.code}. It answers unavailable, which core records and asks again later.`);
    }
  }
};

const NEAR_DUPLICATES = [
  "Tests run with vitest.",
  "Tests run with vitest run.",
  "Tests do not run with vitest.",
  "The API listens on port 3000.",
  "The API listens on port 3001.",
];

const consolidationDeclared: CaseRun = async (harness) => {
  const store = await harness.open();
  const traits = store.traits as { consolidates?: unknown; protects?: unknown } | undefined;
  if (typeof traits?.consolidates !== "boolean" || (traits.consolidates === true && typeof traits.protects !== "boolean")) {
    fail(`The store declares traits ${quote(traits)}. It declares { consolidates: false }, or { consolidates: true, protects } with protects true or false.`);
  }
  if (harness.consolidate && traits.consolidates === false) {
    fail("The harness can make this store consolidate (it gives consolidate), and the store declares consolidates: false. A store that changes what it holds on its own declares it, so core compares what it holds with its own record after every write.");
  }
  // One apply each: an engine that consolidates during an add does it here.
  const ids: string[] = [];
  for (const text of NEAR_DUPLICATES) ids.push(...(await seed(store, REPO, "facts", [text])));
  if (traits.consolidates === false) {
    for (const read of ["first", "second"]) {
      const entries = (await held(store, { subject: REPO, kind: "facts" })).entries;
      const kept = entries.map((entry) => `${entry.id} ${entry.text}`);
      const written = NEAR_DUPLICATES.map((text, index) => `${ids[index]} ${text}`);
      if (quote(kept) !== quote(written) || entries.some((entry) => entry.replacedBy !== undefined)) {
        fail(`A store that declares it does not consolidate held ${quote(kept)} at its ${read} read after five applies wrote ${quote(written)}. It holds exactly what apply left, however alike or contradictory two entries are: same ids, same text, no replacedBy. A store that merges, rewrites or supersedes on its own declares consolidates: true.`);
      }
    }
    return;
  }
  if (!harness.consolidate) return;
  await seed(store, REPO, "facts", ["the api listens on port 3000"]);
  await harness.consolidate(store);
  const entries = (await held(store, { subject: REPO, kind: "facts" })).entries;
  for (const entry of entries) {
    if (entry.replacedBy === undefined) continue;
    if (entry.replacedBy === entry.id || !entries.some((other) => other.id === entry.replacedBy)) {
      fail(`After consolidating, ${quote(entry.text)} is replacedBy ${quote(entry.replacedBy)}, which is not another entry held under ${REPO} facts. replacedBy names the entry, in the same subject and kind, that superseded it.`);
    }
  }
};

const protect: CaseRun = async (harness) => {
  const store = await harness.open();
  const text = "Deploys need a second reviewer.";
  const request = applying(REPO, "facts", { add: [{ text, origin: "human", protect: true }] });
  const what = "An apply adding a protected entry";
  const added = outcomesOf(request, await apply(store, request, what), what)("add", 0);
  if (added.result !== "added") {
    fail(`${what} answered ${quote(added)}. Every store accepts protect: one that consolidates keeps the entry out of it or declares protects: false, and one that does not has nothing to protect it from.`);
  }
  const revised = "Deploys need a second reviewer from another team.";
  const change = applying(REPO, "facts", { update: [{ id: added.id, text: revised, protect: true }] });
  const updated = outcomesOf(change, await apply(store, change, "An update carrying protect"), "An update carrying protect")("update", 0);
  if (updated.result !== "updated") fail(`An update carrying protect answered ${quote(updated)}. Every store accepts protect on an update too.`);
  const traits = store.traits;
  if (!traits.consolidates || !traits.protects) return;
  if (!harness.consolidate) {
    fail("The store declares that protect keeps an entry out of its consolidation, and the harness gives no consolidate to prove it. Give the harness consolidate, a fake of the engine's own pass.");
  }
  await seed(store, REPO, "facts", ["deploys need a second reviewer from another team"]);
  await harness.consolidate(store);
  const entry = entryWithId((await held(store, { subject: REPO, kind: "facts" })).entries, updated.id);
  if (!entry || entry.text !== revised || entry.replacedBy !== undefined) {
    fail(`After consolidating, the protected entry ${quote(revised)} is ${entry ? `held as ${quote(entry)}` : "gone"}. A store that declares protects: true keeps a protected entry out of its consolidation: same id, same text, not superseded.`);
  }
};

const CASES: readonly (readonly [MemoryStoreConformanceCase, CaseRun])[] = [
  ["recall_complete", recallComplete],
  ["recall_ranking", recallRanking],
  ["recall_stored_order", recallStoredOrder],
  ["held_complete", heldComplete],
  ["held_order", heldOrder],
  ["held_version", heldVersion],
  ["apply_add", applyAdd],
  ["apply_update", applyUpdate],
  ["apply_remove", applyRemove],
  ["origins_round_trip", originsRoundTrip],
  ["forget_by_text_hash", forgetByTextHash],
  ["forget_document", forgetDocument],
  ["list_holdings", listHoldings],
  ["subjects_exact", subjectsExact],
  ["entry_fields", entryFields],
  ["refusals_typed", refusalsTyped],
  ["consolidation_declared", consolidationDeclared],
  ["protect", protect],
];

export async function checkMemoryStoreConformance(
  harness: MemoryStoreConformanceHarness,
): Promise<readonly MemoryStoreConformanceIssue[]> {
  const issues: MemoryStoreConformanceIssue[] = [];
  for (const [name, run] of CASES) {
    try {
      await run(harness);
    } catch (error) {
      issues.push({
        case: name,
        message: error instanceof CaseFailure ? error.message : `The case could not run: ${thrown(error)}.`,
      });
    }
  }
  return issues;
}
