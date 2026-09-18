/**
 * A STAND-IN FOR THE MODEL, for tests about what a person gets.
 *
 * Most tests on the answer path are not about how a reply is read; they are
 * about what the record does with a reading, what sentence comes back, and
 * which channel it goes to. Those tests need a reader that answers the same way
 * every time and costs nothing, and without one they would all run against an
 * unreachable provider and prove only that the deterministic fallback exists.
 *
 * THIS IS NOT THE PRODUCT'S READER AND IT PROVES NOTHING ABOUT IT. It is a
 * phrase list, deliberately, because a test fixture has to be predictable; the
 * whole point of the change it stands in for is that the real reader is not one.
 * Whether the real model reads "Yes, please" or "None of the above" correctly is
 * the golden set's question, answered against a real provider on demand, and no
 * assertion here may be read as evidence about it.
 */
import type { RepositoryKey } from "@shared/contracts";
import { withoutQuotedText } from "../../engine/work-scope/answer.js";
import type { AnswerReadingModel, RepositoryQuestion } from "./read-answer.js";

/** The flat object the real provider returns, so the stand-in exercises the
 *  same normalisation and the same allowlist the product depends on. */
interface FakeAnswer {
  outcome: "repositories" | "declined_all" | "declined_one" | "unclear";
  repositoryKeys?: string[];
  paraphrase?: string;
  unofferedNames?: string[];
}

/** Repository names this stand-in knows about beyond the ones a question
 *  offered, so a fixture can say "api and web" to a question about api and the
 *  path that tells somebody about web is exercised. A real model reads the name
 *  out of the reply; a stand-in has to be told which words are names. */
const KNOWN_NAMES = ["api", "web", "docs", "ops", "jobs", "infra", "billing"];

const REFUSALS = [
  "none",
  "none of these",
  "none of them",
  "none of the above",
  "no more repositories",
  "neither",
  "nope",
  "no",
  "nie",
  "zadne",
  "żadne",
  "żadne z nich",
  "continue without it",
  "skip it",
];

const AFFIRMATIVES = new Set([
  "yes",
  "yes please",
  "yep",
  "yeah",
  "sure",
  "ok",
  "okay",
  "tak",
  "go ahead",
]);

function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\n]+/g, " ")
    .replace(/[.!?]+/g, "")
    .trim();
}

/**
 * Read the reply the way the golden set says the real reader should, for the
 * phrasings the suite actually uses.
 *
 * Naming beats refusing, and a refusal has to fit what was asked: the two rules
 * the prompt states, mirrored here so a fixture that relies on either is testing
 * the same shape production will see.
 */
function readFake(answer: string, question: RepositoryQuestion): FakeAnswer {
  // THE WORDS AS HANDED, with nothing taken off. The one channel that composes
  // an author line takes it off before any reader sees the words
  // (`answerAsWritten`), so a colon that reaches here is one somebody typed.
  // Stripping again here would make the stand-in read the dashboard's "api:
  // none" as a refusal (A18) and eat "acme/api: " from a ticket reply's second
  // paragraph, which is the defect the real path no longer has.
  const words = fold(answer);
  // POINTED AT, OR PUSHED AWAY. A name the reply is refusing is not a name the
  // reply is choosing, and the difference is the whole of it: "not the fixture
  // one" names the fixture and wants none of it, so reading the name as a
  // selection records the opposite of what that person wrote.
  const phrases = words.split(/[,\n]|(?: but )|(?: ale )/);
  const pointedAt: RepositoryKey[] = [];
  const pushedAway: RepositoryKey[] = [];
  for (const key of question.askedKeys) {
    const inPhrase = phrases.filter((phrase) => namesKey(phrase, key));
    if (inPhrase.length === 0) continue;
    if (inPhrase.some((phrase) => !NEGATION.test(phrase))) pointedAt.push(key);
    else pushedAway.push(key);
  }
  // NAMES THE QUESTION NEVER OFFERED, pointed at rather than pushed away. They
  // are told back to the person and never recorded, which is the whole reason
  // the reader reports them separately from the keys.
  const offered = new Set(question.askedKeys.map((key) => lastName(key)));
  const unofferedNames = phrases
    .filter((phrase) => !NEGATION.test(phrase))
    .flatMap((phrase) =>
      KNOWN_NAMES.filter(
        (name) => !offered.has(name) && new RegExp(`(^|[\\s,])${name}([\\s,.]|$)`).test(phrase),
      ),
    );
  const told = unofferedNames.length > 0 ? { unofferedNames: [...new Set(unofferedNames)] } : {};
  if (pointedAt.length > 0) {
    return { outcome: "repositories", repositoryKeys: pointedAt, ...told };
  }
  if (pushedAway.length > 0) {
    // Under a question about ONE repository the refused set and the offered set
    // are the same thing, so pushing it away IS the decline. Under a list it is
    // not: what is left over is our subtraction, not their answer.
    return question.shape === "one" && pushedAway.includes(question.askedKeys[0])
      ? { outcome: "declined_one" }
      : { outcome: "unclear", paraphrase: `"${answer.slice(0, 60)}" says what to avoid, not what to use` };
  }
  if (REFUSALS.some((phrase) => words === phrase || words.startsWith(`${phrase} `) || words.startsWith(`${phrase},`))) {
    return question.shape === "one"
      ? { outcome: "declined_one", ...told }
      : { outcome: "declined_all", ...told };
  }
  if (question.shape === "one" && AFFIRMATIVES.has(words)) {
    return { outcome: "repositories", repositoryKeys: [question.askedKeys[0]] };
  }
  if (question.shape === "list" && ["all", "all of them", "wszystkie"].includes(words)) {
    return { outcome: "repositories", repositoryKeys: question.askedKeys };
  }
  return {
    outcome: "unclear",
    paraphrase: `nothing in "${answer.slice(0, 60)}" settles it`,
    ...told,
  };
}

const NEGATION = /(^|\s)(not|no|nie|without|except|skip|avoid|exclude|bez|pomin|oprocz)(\s|$)/;

function pathOf(key: RepositoryKey): string {
  return key.slice(key.indexOf(":") + 1);
}

function lastName(key: RepositoryKey): string {
  const path = pathOf(key);
  return path.slice(path.lastIndexOf("/") + 1);
}

function namesKey(phrase: string, key: RepositoryKey): boolean {
  return phrase.includes(key) || phrase.includes(pathOf(key)) || namesTail(phrase, key);
}

function namesTail(words: string, key: RepositoryKey): boolean {
  const path = pathOf(key);
  const name = path.slice(path.lastIndexOf("/") + 1);
  return new RegExp(`(^|[\\s,])${name}([\\s,.]|$)`).test(words);
}

/** The stand-in, as the reader dependency the answer path takes. */
export function fakeAnswerReadingModel(): AnswerReadingModel {
  return async (input) => {
    const question = questionFromPrompt(input.prompt);
    // OUR OWN QUESTION IS NOT TESTIMONY, and the stand-in has to know it too.
    // The prompt hands the reader the reply whole, quoted question and all,
    // because that is what the real reader needs to see; a stand-in that read
    // the keys out of our own quoted sentence would attach the repositories a
    // person was refusing underneath it.
    const reply = withoutQuotedText(replyFromPrompt(input.prompt), question.questions);
    return { object: readFake(reply, question) };
  };
}

/** The reply, pulled back out of the prompt the reader built. The stand-in sees
 *  exactly what the provider would see, markers and all, so a prompt that
 *  stopped carrying the reply whole would fail here too. Exported for the tests
 *  that assert on what a reader was handed, so they pull the words out the same
 *  way the stand-in does. */
export function replyFromPrompt(prompt: string): string {
  return prompt.split("<<<REPLY\n")[1]?.split("\nREPLY>>>")[0] ?? "";
}

function questionFromPrompt(prompt: string): RepositoryQuestion {
  const keys = JSON.parse(
    prompt.split("These are the only keys you may return:\n")[1]?.split("\n")[0] ?? "[]",
  ) as RepositoryKey[];
  const held = JSON.parse(
    prompt.split("they are context, not choices:\n")[1]?.split("\n")[0] ?? "[]",
  ) as RepositoryKey[];
  const asked =
    prompt.split("The question, as the person saw it (OUR words, not theirs):\n")[1]?.split("\n\nThe repository keys")[0] ?? "";
  return {
    questions: asked.length > 0 ? asked.split("\n") : [],
    askedKeys: keys,
    shape: prompt.includes("exactly ONE repository") ? "one" : "list",
    heldKeys: held,
  };
}
