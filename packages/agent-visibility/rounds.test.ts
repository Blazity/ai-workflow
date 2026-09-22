import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleClarificationRounds,
  clarificationRoundHeader,
  clarificationRoundHeaderSchema,
  clarificationRoundSchema,
  readVisibilityRecord,
  type ClarificationRoundRows,
} from "./index";

/** The rounds alone; each test that expects skipped rows asserts them. */
const assembleRounds = (rows: Parameters<typeof assembleClarificationRounds>[0]) => {
  const assembly = assembleClarificationRounds(rows);
  assert.deepEqual(assembly.skipped, []);
  return assembly.rounds;
};

type QuestionRow = ClarificationRoundRows["questions"][number];
type DeliveryRow = ClarificationRoundRows["deliveries"][number];

const at = (minute: number) => new Date(Date.UTC(2026, 8, 19, 9, minute)).toISOString();

const QUESTION = "Which repository should AWP-235 modify?";
const filip = { kind: "person", display: "Filip" };

function question(change: Partial<QuestionRow> = {}): QuestionRow {
  return {
    clarificationId: "c1",
    runId: "r1",
    nodeId: "planning",
    questions: [QUESTION],
    askedAt: at(0),
    status: "answered",
    offered: [
      { key: "github:acme/web", askedBecause: "selection", named: true },
      { key: "github:acme/api", askedBecause: "selection", named: true },
    ],
    ...change,
  };
}

const unclear = (minute: number, readBy = "model") => ({
  version: 1,
  outcome: { kind: "unclear", paraphrase: "They may mean the web app." },
  readBy,
  ...(readBy === "model" ? { model: "claude-haiku-4-5" } : {}),
  readAt: at(minute),
});

function delivery(minute: number, words: string, change: Partial<DeliveryRow> = {}): DeliveryRow {
  return {
    clarificationId: "c1",
    words,
    author: filip,
    surface: "jira",
    firstAt: at(minute),
    reading: unclear(minute),
    note: null,
    ...change,
  };
}

// Red when: an unclear reading opens a new round, or overwrites the delivery
// before it, which is how the history of a round got lost.
test("two unclear deliveries and a clear one are one round with three deliveries", () => {
  const clear = {
    version: 1,
    outcome: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
    readBy: "model",
    model: "claude-haiku-4-5",
    readAt: at(30),
  };
  const rounds = assembleRounds({
    questions: [question()],
    deliveries: [
      delivery(10, "the frontend one", { note: "I could not tell which repository you meant." }),
      delivery(20, "the frontend one, the web app", { note: "I could not tell which repository you meant." }),
      delivery(30, "github:acme/web", { reading: clear, note: "Recorded github:acme/web for this ticket." }),
    ],
    trail: [
      { id: 1, at: at(0), event: { kind: "question_asked", clarificationId: "c1", repositories: [], purpose: "narrowing" } },
      { id: 2, at: at(30), event: { kind: "question_answered", clarificationId: "c1", answer: { kind: "repositories", repositoryKeys: ["github:acme/web"] } } },
      { id: 3, at: at(30), event: { kind: "entry_written", clarificationId: "c1", previousState: null } },
      { id: 4, at: at(40), event: { kind: "entry_written", previousState: "selected" } },
      { id: 5, at: at(41), event: { kind: "entry_removed" } },
    ],
  });

  assert.equal(rounds.length, 1);
  const round = rounds[0]!;
  assert.equal(round.id, "c1");
  assert.equal(round.status, "answered");
  assert.deepEqual(round.question, {
    questions: [QUESTION],
    questionCount: 1,
    askedAt: at(0),
    offered: [
      { key: "github:acme/web", askedBecause: "selection", named: true },
      { key: "github:acme/api", askedBecause: "selection", named: true },
    ],
    offeredCount: 2,
    purpose: "narrowing",
    askedAgain: false,
  });
  assert.deepEqual(
    round.deliveries.map((entry) => [entry.words, entry.count, entry.reading?.outcome.kind, entry.note]),
    [
      ["the frontend one", 1, "unclear", "I could not tell which repository you meant."],
      ["the frontend one, the web app", 1, "unclear", "I could not tell which repository you meant."],
      ["github:acme/web", 1, "repositories", "Recorded github:acme/web for this ticket."],
    ],
  );
  assert.equal(round.deliveryCount, 3);
  assert.equal(round.arrivalCount, 3);
  // What the record did: the answer and the entry it wrote, not the manual
  // edit or the removal that carry no clarification id.
  assert.deepEqual(
    round.effects.map((effect) => [effect.trailId, effect.event.kind]),
    [
      [2, "question_answered"],
      [3, "entry_written"],
    ],
  );
  assert.equal(readVisibilityRecord(clarificationRoundSchema, JSON.parse(JSON.stringify(round))).ok, true);
});

// Red when: every poll tick of a weekend becomes its own delivery and buries
// the round.
test("two hundred identical poll deliveries are one delivery with a count of 200", () => {
  const first = delivery(0, "the frontend one", { note: "I could not tell which repository you meant." });
  const ticks = Array.from({ length: 199 }, (_unused, index) => delivery(index + 1, "the frontend one", { note: null }));
  const [round] = assembleRounds({
    questions: [question({ status: "pending" })],
    deliveries: [first, ...ticks],
    trail: [],
  });
  assert.equal(round!.deliveries.length, 1);
  assert.deepEqual(
    [round!.deliveries[0]!.count, round!.deliveries[0]!.firstAt, round!.deliveries[0]!.lastAt, round!.deliveries[0]!.note],
    [200, at(0), at(199), "I could not tell which repository you meant."],
  );
  assert.equal(round!.deliveryCount, 1);
  assert.equal(round!.arrivalCount, 200);
});

// Red when: identical deliveries merge across a different one in between,
// which rewrites the order in which a person said things.
test("only consecutive identical deliveries merge: A, B, A is three", () => {
  const [round] = assembleRounds({
    questions: [question({ status: "pending" })],
    deliveries: [delivery(1, "api"), delivery(2, "web"), delivery(3, "api")],
    trail: [],
  });
  assert.deepEqual(
    round!.deliveries.map((entry) => [entry.words, entry.count]),
    [
      ["api", 1],
      ["web", 1],
      ["api", 1],
    ],
  );
});

// Red when: a reading made while the model was unreachable outlives the
// model's own reading of the same words.
test("a model reading after a deterministic fallback wins in a merged delivery", () => {
  const modelReading = {
    version: 1,
    outcome: { kind: "repositories", repositoryKeys: ["github:acme/web"] },
    readBy: "model",
    model: "claude-haiku-4-5",
    readAt: at(2),
  };
  const [round] = assembleRounds({
    questions: [question()],
    deliveries: [
      delivery(1, "web please", { reading: unclear(1, "deterministic"), note: "The reader was unavailable." }),
      delivery(2, "web please", { reading: modelReading, note: "Recorded github:acme/web for this ticket." }),
      delivery(3, "web please", { reading: unclear(3, "deterministic"), note: null }),
    ],
    trail: [],
  });
  const merged = round!.deliveries[0]!;
  assert.equal(merged.count, 3);
  assert.deepEqual(merged.reading, {
    ...modelReading,
    outcome: { ...modelReading.outcome, repositoryKeyCount: 1 },
  });
  assert.equal(merged.note, "Recorded github:acme/web for this ticket.");
});

// Red when: a question a retried attempt wrote again reads as a second round,
// or a different question is folded into the first.
test("a question asked again after a retry is one round marked asked again", () => {
  const rounds = assembleRounds({
    questions: [
      question({ clarificationId: "c1", status: "cancelled" }),
      question({ clarificationId: "c2", askedAt: at(5), status: "answered" }),
      question({ clarificationId: "c3", askedAt: at(50), questions: ["Should the API change too?"], status: "pending" }),
    ],
    deliveries: [
      delivery(7, "web", { clarificationId: "c2" }),
      delivery(3, "hello?", { clarificationId: "c1" }),
    ],
    trail: [],
  });
  assert.equal(rounds.length, 2);
  const [retried, other] = rounds;
  assert.equal(retried!.id, "c1");
  assert.equal(retried!.question.askedAgain, true);
  assert.equal(retried!.question.askedAt, at(0));
  assert.deepEqual(
    retried!.asks.map((ask) => [ask.clarificationId, ask.status]),
    [
      ["c1", "cancelled"],
      ["c2", "answered"],
    ],
  );
  assert.equal(retried!.status, "answered");
  assert.deepEqual(
    retried!.deliveries.map((entry) => [entry.clarificationId, entry.words]),
    [
      ["c1", "hello?"],
      ["c2", "web"],
    ],
  );
  assert.equal(other!.id, "c3");
  assert.equal(other!.question.askedAgain, false);
});

// Red when: a question asked again after it was ANSWERED is folded into the
// answered round, hiding that the agent asked twice.
test("the same question after an answer is a new round", () => {
  const rounds = assembleRounds({
    questions: [question({ clarificationId: "c1" }), question({ clarificationId: "c4", askedAt: at(90), status: "pending" })],
    deliveries: [],
    trail: [],
  });
  assert.deepEqual(
    rounds.map((round) => [round.id, round.question.askedAgain]),
    [
      ["c1", false],
      ["c4", false],
    ],
  );
});

// Red when: rows the store already merged are counted as one arrival each.
test("stored deliveries that already carry a count merge with the next identical one", () => {
  const [round] = assembleRounds({
    questions: [question({ status: "pending" })],
    deliveries: [
      delivery(1, "the frontend one", { count: 5, lastAt: at(5) }),
      delivery(6, "the frontend one"),
    ],
    trail: [],
  });
  assert.deepEqual(
    [round!.deliveries[0]!.count, round!.deliveries[0]!.firstAt, round!.deliveries[0]!.lastAt, round!.arrivalCount],
    [6, at(1), at(6), 6],
  );
});

// Red when: arrivals the store already merged across another delivery (A, B,
// A stored as A twice and B) are shown as if the person said A before B, or
// sorted by their first arrival, which puts the answer that is current last
// in the wrong place.
test("a store-merged delivery spanning another is flagged and ordered by its latest arrival", () => {
  const [round] = assembleRounds({
    questions: [question({ status: "pending" })],
    deliveries: [
      delivery(1, "api", { count: 2, lastAt: at(3) }),
      delivery(2, "web"),
    ],
    trail: [],
  });
  assert.deepEqual(
    round!.deliveries.map((entry) => [entry.words, entry.count, entry.firstAt, entry.lastAt, entry.mergeConflict]),
    [
      ["web", 1, at(2), at(2), false],
      ["api", 2, at(1), at(3), true],
    ],
  );
  // Raw rows in the same order are three deliveries, none in conflict.
  const [raw] = assembleRounds({
    questions: [question({ status: "pending" })],
    deliveries: [delivery(1, "api"), delivery(2, "web"), delivery(3, "api")],
    trail: [],
  });
  assert.deepEqual(raw!.deliveries.map((entry) => entry.mergeConflict), [false, false, false]);
});

// Red when: a question a retry loop wrote twenty times lists twenty asks, or
// keeps the oldest ones and loses the latest status.
test("a round lists its first ask and the newest ones, and counts all of them", () => {
  const asks = Array.from({ length: 20 }, (_unused, index) =>
    question({ clarificationId: `c${index + 1}`, askedAt: at(index), status: "cancelled" }),
  );
  asks[19] = { ...asks[19]!, status: "pending" };
  const [round] = assembleRounds({ questions: asks, deliveries: [], trail: [] });
  assert.equal(round!.askCount, 20);
  assert.equal(round!.asks.length, 16);
  assert.deepEqual(
    round!.asks.map((ask) => ask.clarificationId),
    ["c1", ...Array.from({ length: 15 }, (_unused, index) => `c${index + 6}`)],
  );
  assert.equal(round!.status, "pending");
});

// Red when: text at or past a bound makes the assembler produce a round its
// own schema refuses, or throw, or shorten without saying so.
test("words, notes, questions and names past their bounds are clamped and the round still parses", () => {
  const questions = Array.from({ length: 12 }, (_unused, index) => `${index}:${"q".repeat(5_000)}`);
  const [round] = assembleRounds({
    questions: [question({ questions, status: "pending" })],
    deliveries: [
      delivery(1, "w".repeat(25_000), {
        note: "n".repeat(5_000),
        author: { kind: "person", display: "a".repeat(300) },
      }),
      delivery(2, "w".repeat(20_000)),
    ],
    trail: [],
  });
  assert.equal(round!.question.questions.length, 10);
  assert.equal(round!.question.questionCount, 12);
  assert.equal(round!.question.questions[0]!.length, 4_000);
  assert.match(round!.question.questions[0]!, /\u2026 \(5002 characters in full\)$/);
  const [long, exact] = round!.deliveries;
  assert.equal(long!.words.length, 20_000);
  assert.match(long!.words, /\u2026 \(25000 characters in full\)$/);
  assert.equal(long!.note!.length, 4_000);
  assert.equal(long!.author.display.length, 200);
  // Exactly at the bound is kept whole.
  assert.equal(exact!.words, "w".repeat(20_000));
  assert.equal(readVisibilityRecord(clarificationRoundSchema, JSON.parse(JSON.stringify(round))).ok, true);
});

// Red when: a round header carries its deliveries or effects (which grow
// without bound and are served as their own lists), or loses their counts.
test("a round header drops its deliveries and effects and keeps their counts", () => {
  const [round] = assembleRounds({
    questions: [question()],
    deliveries: [delivery(1, "web"), delivery(2, "web please")],
    trail: [
      { id: 1, at: at(0), event: { kind: "question_asked", clarificationId: "c1", repositories: [], purpose: "narrowing" } },
      { id: 2, at: at(2), event: { kind: "question_answered", clarificationId: "c1" } },
    ],
  });
  const header = clarificationRoundHeader(round!);
  assert.equal("deliveries" in header, false);
  assert.equal("effects" in header, false);
  assert.deepEqual([header.deliveryCount, header.arrivalCount, header.effectCount], [2, 2, 1]);
  assert.equal(readVisibilityRecord(clarificationRoundHeaderSchema, JSON.parse(JSON.stringify(header))).ok, true);
});

// Red when: a question asked again after the answer was taken but the run
// could not resume is folded into the answered round, hiding that the person
// had to answer twice.
test("the same question after a resume failure is a new round", () => {
  const rounds = assembleRounds({
    questions: [
      question({ clarificationId: "c1", status: "resume_failed" }),
      question({ clarificationId: "c2", askedAt: at(30), status: "pending" }),
    ],
    deliveries: [],
    trail: [],
  });
  assert.deepEqual(rounds.map((round) => [round.id, round.question.askedAgain]), [
    ["c1", false],
    ["c2", false],
  ]);
});

// Red when: a question offering more repositories than the ceiling, or a
// reading naming more keys, refuses every round of the subject, or loses the
// ones past the ceiling without a count.
test("17 offered repositories and 17 reading keys are listed to the ceiling and counted", () => {
  const keys = Array.from({ length: 17 }, (_unused, index) => `github:acme/service-${index}`);
  const reading = {
    version: 1,
    outcome: { kind: "repositories", repositoryKeys: keys },
    readBy: "model",
    model: "claude-haiku-4-5",
    readAt: at(1),
    unofferedNames: Array.from({ length: 17 }, (_unused, index) => `name ${index}`),
  };
  const [round] = assembleRounds({
    questions: [question({ offered: keys.map((key) => ({ key, askedBecause: "selection", named: false })) })],
    deliveries: [delivery(1, "all of them", { reading })],
    trail: [],
  });
  assert.equal(round!.question.offered!.length, 16);
  assert.equal(round!.question.offeredCount, 17);
  assert.equal(round!.question.offered![15]!.key, "github:acme/service-15");
  const read = round!.deliveries[0]!.reading!;
  assert.equal(read.outcome.repositoryKeys!.length, 16);
  assert.equal(read.outcome.repositoryKeyCount, 17);
  assert.equal(read.unofferedNames!.length, 16);
  assert.equal(read.unofferedNameCount, 17);
  assert.equal(readVisibilityRecord(clarificationRoundSchema, JSON.parse(JSON.stringify(round))).ok, true);
});

// Red when: one row that cannot be read throws away every round of the
// subject, or is dropped without a trace on the round it belonged to.
test("a row that cannot be read costs only its own round, and is named", () => {
  const assembly = assembleClarificationRounds({
    questions: [
      question({ clarificationId: "c1" }),
      question({ clarificationId: "c2", askedAt: at(40), questions: ["Should the API change too?"], status: "pending" }),
      // No time a reader could place: this question cannot be shown.
      question({ clarificationId: "c3", askedAt: "yesterday", questions: ["Which branch?"], status: "pending" }),
    ],
    deliveries: [
      delivery(10, "web"),
      // A delivery of c2 whose surface is not a slug: left out of c2 only.
      delivery(41, "yes", { clarificationId: "c2", surface: "Jira Cloud" }),
      delivery(42, "yes, the API too", { clarificationId: "c2" }),
    ],
    trail: [],
  });
  assert.deepEqual(
    assembly.rounds.map((round) => [round.id, round.deliveryCount, round.skippedRows]),
    [
      ["c1", 1, 0],
      ["c2", 1, 1],
    ],
  );
  assert.deepEqual(
    assembly.skipped.map((entry) => [entry.rows, entry.position, entry.clarificationId]),
    [
      ["questions", 2, "c3"],
      ["deliveries", 1, "c2"],
    ],
  );
  assert.match(assembly.skipped[1]!.problem, /surface/);
  assert.equal(assembly.skipped[1]!.problem.includes("Jira Cloud"), false);
  assert.equal(clarificationRoundHeader(assembly.rounds[1]!).skippedRows, 1);
});

// Red when: something that is not rows at all is read as a subject with no
// rounds, which would tell a person nobody was ever asked.
test("a value that is not the three lists of rows is refused", () => {
  assert.throws(
    () => assembleClarificationRounds({ questions: [], deliveries: [] } as unknown as ClarificationRoundRows),
    /not three lists of questions, deliveries and trail rows/,
  );
});
