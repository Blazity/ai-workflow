import {
  repositoryCatalogKey,
  type RepositoryKey,
  type WorkScopeQuestionAnswer,
} from "@shared/contracts";
import {
  PROVIDER_BY_HOST,
  foldPolishDiacritics,
  isRefusalAnswer,
  parseRepositoryExpansionAnswer,
  withoutQuotedQuestions,
  type ParsedRepositoryIdentity,
} from "../repository-discovery/runner.js";

// The contract's bound on the repositories one answer may name.
const ANSWER_REPOSITORIES_MAX = 8;

const UNRECOGNISED: WorkScopeQuestionAnswer = { kind: "unrecognised" };

// The whole answer, and nothing but these phrases, is a yes. A question about
// ONE repository is usually answered by agreeing with it rather than by
// spelling its key out again, and reading that as unreadable costs the person
// a second question. Matched exactly, never as a substring, so "yes, but the
// other one" stays unreadable.
const AFFIRMATIVE_ANSWERS = new Set([
  "yes",
  "y",
  "yep",
  "yeah",
  "yes please",
  "sure",
  "ok",
  "okay",
  "go ahead",
  "do it",
  "please do",
  "confirmed",
  "correct",
  "use it",
  "add it",
  // People answer this question in Polish as often as in English, and a yes
  // nobody can read costs them the same second question as a no.
  "tak",
  "tak, dodaj",
  "dodaj",
  "uzyj",
]);

// The whole answer, and nothing but these phrases, is every repository the
// question listed. A question offering three repositories is answered "all" by
// somebody who means all three, and reading that as unreadable costs them a
// round for the one reply that is not ambiguous at all. Matched exactly, like
// the affirmatives above, so "all of the frontend ones" stays unreadable.
//
// EACH WORD IS GATED ON THE COUNT IT MEANS, and null means any count. "both"
// against a question that listed four repositories is not somebody agreeing to
// four: the word and the list contradict each other, and the reply that
// contradicts the question in front of it is exactly the one this reader must
// not turn into a decision in that person's name (A34).
const ALL_OF_THEM = new Map<string, number | null>([
  ["all", null],
  ["all of them", null],
  ["all of these", null],
  ["wszystkie", null],
  ["wszystkie z nich", null],
  ["all three", 3],
  ["both", 2],
  ["both of them", 2],
  ["oba", 2],
  ["obie", 2],
  // The forms people actually type beside those two. "obydwa" and "obydwie" are
  // the everyday spelling of "both" in Polish, and a question listing three
  // repositories is answered "wszystkie trzy" as readily as "all three". Missing
  // from the map, each of them was unreadable and the question came back for a
  // reply nobody could mistake.
  ["obydwa", 2],
  ["obydwie", 2],
  ["wszystkie trzy", 3],
]);

// The words a person says no with, compared on word boundaries against what
// they wrote AROUND the repositories they named. Polish is folded to ASCII
// first, so "nie" covers both spellings of its kin. "no need" needs no entry:
// "no" already carries it, and "none" needs its own because "no" does not
// reach inside it.
//
// The contrastive half ("instead", "rather", "zamiast") is here because our
// own copy teaches it: the excluded question ends with "or with the
// repositories this ticket should use instead", and an answer that took us up
// on that named the rejected repository beside the chosen one, which was then
// recorded as selected in the name of the person rejecting it.
const NEGATION_WORDS =
  /\b(?:no|none|not|dont|doesnt|wont|cant|without|never|skip|exclude|remove|drop|ignore|forget|except|instead|rather|nie|bez|zaden|zadne|zamiast|pomin|usun)\b/;

// "leave acme/api out" puts the repository between the two words, so the pair
// is matched across the line rather than as one phrase.
const LEAVE_OUT = /\bleave\b[^\n]*\bout\b/;

// "out of scope" is three words that only mean no together: "out" alone is
// half of "leave out" and "scope" alone is this feature's own noun.
const OUT_OF_SCOPE = /\bout of scope\b/;

// "keep acme/web out" says no with a word that is otherwise ordinary.
const KEEP_OUT = /\bkeep\b[^\n]*\bout\b/;

/**
 * The one reader of a person's answer to a repository question. Where the
 * answer arrives and the protocol that asked both read it here, so a replay
 * and the record see the same answer.
 *
 * `catalogKeys` are the keys an answer may name: the catalog store's keys plus
 * the keys this question asked about, so a person naming back the repository
 * they were asked about is understood even when the catalog table does not
 * hold it. `askedKeys` are those asked keys alone. `askedQuestions` are the
 * questions the clarification actually asked, which is the only thing we know
 * for certain about the conversation: a line of the answer that repeats one of
 * them is our own words coming back, not testimony.
 *
 * `keptKeys` are the repositories the question SHOWED as already part of this
 * work and kept whatever the reply (the which-of-these question names them,
 * A11g). They are not asked, and a reply does not change them: naming one is
 * not recorded, and a plain yes beside them is not read as the one choice.
 * Absent means the question showed none.
 *
 * A REPLY THAT SAYS NO ABOUT ANYTHING RECORDS NOTHING, AND THE QUESTION COMES
 * BACK. This reader used to try to work out what a no attached to: which clause
 * it sat in, whether the words beside it chose something else, whether a
 * contrast made the other name a choice. Every defect this feature has had came
 * out of that attempt, because the ways people write a no do not end, and each
 * wrong reading is a decision recorded in the name of somebody who said the
 * opposite. So a no, anywhere in the reply, makes the whole reply unreadable
 * and the person is told what to write instead (rule 1). Under-reading is the
 * cheap failure here: a repeated question costs a round and explains itself.
 *
 * The ONE no that still decides is a reply that is nothing but a refusal. This
 * answer is threaded to the question that asked it, so "no" has exactly one
 * thing it can be about: every repository the question listed, and that is what
 * it declines.
 *
 * A guess is never an answer either: an identity the catalog does not hold, a
 * path two providers share, or prose that is not a plain list of names is
 * unrecognised, and the protocol asks its follow-up rather than recording a
 * repository against a person's name. What this reader records outlives the
 * run, so a repeated question is a cost and a fabricated decision is a defect,
 * and every ambiguity here resolves to unrecognised (A34).
 */
export function readRepositoryAnswer(
  answer: string,
  input: {
    catalogKeys: RepositoryKey[];
    askedKeys: RepositoryKey[];
    askedQuestions: string[];
    keptKeys?: RepositoryKey[];
  },
): WorkScopeQuestionAnswer {
  // Our own words come out FIRST, and every rule below reads what is left. It
  // used to matter only for the naming rules; it is now what keeps the rule
  // above from reading our own sentences as the person's refusal. The way back
  // this system prints to a ticket contains the word "not", so a person who
  // quotes our comment and writes "yes, bring it back" underneath would be
  // refused every single time.
  const theirWords = withoutQuotedText(answer, input.askedQuestions);
  // An answer made of nothing but our own words is not an answer. It is the
  // quote button, or a mail client's `>`, and reading a repository out of it
  // would record OUR key as the person naming it, over the very decision they
  // are being asked about.
  if (!/[a-z0-9]/iu.test(theirWords)) return UNRECOGNISED;
  const testimony = whatThePersonNamed(theirWords, input.catalogKeys);
  const spelled = namedRepositories(testimony, input.catalogKeys);
  const keptKeys = input.keptKeys ?? [];
  if (saysNo(testimony)) {
    // The one no that decides: a refusal that names no repository at all. It is
    // threaded to the question that asked it, so there is exactly one thing it
    // can be about, which is everything that question listed.
    if (spelled === null && saysNothingToAttach(theirWords)) return { kind: "none" };
    // Every other no, wherever it sits and whatever else the reply says.
    // Working out what it attached to is the guess this reader no longer makes.
    return UNRECOGNISED;
  }
  if (spelled !== null) {
    if (spelled === "unresolved") return UNRECOGNISED;
    // Naming a kept repository records nothing about it: the question said it
    // stays whatever the reply, so the reply does not turn the reason it is
    // held into a person's selection.
    return readRepositories(spelled.keys.filter((key) => !keptKeys.includes(key)));
  }
  // A reply of bare names ("api, web") is how people answer when the question
  // listed the repositories. Every token must be such a name, so a sentence
  // that happens to contain one is not read as a choice.
  const named = readBareNames(testimony, input.catalogKeys);
  if (named !== null) return readRepositories(named.filter((key) => !keptKeys.includes(key)));
  // A question about ONE repository, and only that: a yes under a question
  // that also showed kept repositories may be agreeing to keep them.
  if (input.askedKeys.length === 1 && keptKeys.length === 0 && isAffirmative(theirWords)) {
    return { kind: "repositories", repositoryKeys: [input.askedKeys[0]] };
  }
  // "all", for a question that listed what all of them are. There is nothing to
  // work out here: the reply is threaded to that question, and the choices it
  // offered are the only thing "all" can mean. A word that counts ("both",
  // "all three") has to agree with the list, or it is not about this question.
  if (input.askedKeys.length > 0 && isAllOfThem(theirWords, input.askedKeys.length)) {
    return readRepositories(input.askedKeys.filter((key) => !keptKeys.includes(key)));
  }
  return UNRECOGNISED;
}

/**
 * Does this reply name a repository the question showed as kept, in a way the
 * person is owed a sentence about?
 *
 * Two readings reach here, and both leave the record untouched: a reply trying
 * to drop a kept repository, which cannot be split from the rest of it, and a
 * reply naming only kept repositories, which records nothing because the
 * question said they stay. Spelled out as a path or a link it counts however it
 * was written; as a bare name it counts only beside a no, because "the docs"
 * in a sentence is not somebody naming a repository.
 */
export function answerNamesKeptRepositories(
  answer: string,
  input: {
    catalogKeys: RepositoryKey[];
    askedQuestions: string[];
    keptKeys: RepositoryKey[];
  },
): boolean {
  if (input.keptKeys.length === 0) return false;
  const theirWords = withoutQuotedText(answer, input.askedQuestions);
  if (!/[a-z0-9]/iu.test(theirWords)) return false;
  const testimony = whatThePersonNamed(theirWords, input.catalogKeys);
  const spelled = namedRepositories(testimony, input.catalogKeys);
  if (
    spelled !== null &&
    spelled !== "unresolved" &&
    spelled.keys.some((key) => input.keptKeys.includes(key))
  ) {
    return true;
  }
  if (!saysNo(testimony)) return false;
  return namesByBareName(testimony, input.keptKeys, input.catalogKeys);
}

/**
 * Does this text name one of these repositories by its bare name, where that
 * name belongs to exactly one repository this deployment holds?
 *
 * Read only beside a no, by both callers. "the docs" in a sentence is not
 * somebody naming a repository, and taking one on a bare word would attach
 * repositories nobody chose; beside a refusal the same word is what people
 * actually write, and the only thing it buys is a truer sentence back.
 */
function namesByBareName(
  testimony: string,
  keys: readonly RepositoryKey[],
  catalogKeys: RepositoryKey[],
): boolean {
  const tokens = new Set(
    testimony
      .split(/[\s,]+/)
      .map((token) => normalizeToken(token).toLowerCase())
      .filter((token) => token.length > 0),
  );
  return keys.some((key) => {
    const name = lastPathSegment(key);
    return (
      tokens.has(name) &&
      catalogKeys.filter((other) => lastPathSegment(other) === name).length === 1
    );
  });
}

/**
 * Did this reply say no AND name a repository?
 *
 * The reply that is not a plain refusal, told apart from one that is, because
 * the two are owed different sentences. "github:acme/infra, but do not touch
 * github:acme/billing" names two repositories and refuses at least one of them,
 * and "nothing in that answer named a repository this work should use" would be
 * plainly false to the person who wrote it. What they are told instead is the
 * rule: a reply that says no about anything records nothing, so name only the
 * repositories to use.
 *
 * A BARE NAME COUNTS HERE, exactly as it does for a kept repository above.
 * "nie, tylko ops" and "no, just ops" are how people write, and the sentence
 * saying nothing in the answer named a repository reads as nonsense to somebody
 * who just named one; worse, it is the one sentence that never tells them the
 * rule they fell foul of.
 */
export function answerSaysNoAndNamesARepository(
  answer: string,
  input: { catalogKeys: RepositoryKey[]; askedQuestions: string[] },
): boolean {
  const theirWords = withoutQuotedText(answer, input.askedQuestions);
  if (!/[a-z0-9]/iu.test(theirWords)) return false;
  // A reply that is nothing but a refusal names nothing by definition, and it
  // is not this: it decides, and the record keeps it.
  if (saysNothingToAttach(theirWords)) return false;
  const testimony = whatThePersonNamed(theirWords, input.catalogKeys);
  if (!saysNo(testimony)) return false;
  const spelled = namedRepositories(testimony, input.catalogKeys);
  if (spelled !== null && spelled !== "unresolved" && spelled.keys.length > 0) return true;
  return namesByBareName(testimony, input.catalogKeys, input.catalogKeys);
}

/** The repositories an answer spells out. Null when it spells out none;
 *  "unresolved" when one of them is not a key this deployment holds, which
 *  makes the whole answer unreadable (A34). */
function namedRepositories(
  testimony: string,
  catalogKeys: RepositoryKey[],
): { keys: RepositoryKey[] } | "unresolved" | null {
  const identities = parseRepositoryExpansionAnswer(testimony);
  if (identities.length === 0) return null;
  const resolved: RepositoryKey[] = [];
  for (const identity of identities) {
    const key = resolveIdentity(identity, catalogKeys);
    if (key === null) return "unresolved";
    resolved.push(key);
  }
  return { keys: [...new Set(resolved)] };
}

/**
 * Does this reply say no about anything at all?
 *
 * THE ANSWER PATH'S READING, for a caller holding a reply rather than the
 * verdict `readRepositoryAnswer` gives one: the direct reply a run resumes on,
 * which the run matches leniently against its listing, and the same reply asked
 * about before a routing memory is stored. A no anywhere in it makes it
 * unreadable, for the reason the reader above gives: the reply is threaded to
 * our question, so the no may be about anything that question offered, and
 * every attempt to work out which was a decision recorded against somebody who
 * said the opposite.
 *
 * NOT THE TICKET'S READING, and it used to be. The ticket's own words and its
 * comments are not a reply to anything, and reading them this way made "fix the
 * login bug in github:acme/api, but do not deploy yet" a refusal of api. They go
 * through `ticketTextExcludesARepository` (`ticket-text.ts`), which asks for a
 * phrasing that keeps us out of a repository and for the path to share a phrase
 * with it.
 *
 * Quoted lines come out first, for the reason they do everywhere on this path: a
 * person replying to our comment quotes a sentence built around "not", and
 * their own word is what is being read.
 */
export function replySaysNoAboutAnything(reply: string): boolean {
  return saysNo(withoutQuotedText(reply, []));
}

/**
 * Is this reply a word that counts repositories, saying a different number from
 * the one the question listed?
 *
 * "both" under a question offering three is neither a choice nor a refusal: the
 * word and the list contradict each other, so the reader records nothing
 * (`isAllOfThem`). What the person was told, until now, was that nothing in
 * their answer named a repository, which says nothing about the count and sends
 * them back to the same word. Asked here so the sentence they read can name the
 * real reason.
 *
 * Only a counting word, and only a disagreeing one: "all" means whatever the
 * question listed and never reaches this, and a counting word that agrees was
 * read as the whole list.
 */
export function answerCountsAgainstTheList(
  answer: string,
  input: { askedQuestions: string[]; askedCount: number },
): boolean {
  const theirWords = withoutQuotedText(answer, input.askedQuestions);
  const means = ALL_OF_THEM.get(wholeReply(theirWords));
  return means !== undefined && means !== null && means !== input.askedCount;
}

/**
 * What the person's own words NAME, with the links that name no repository of
 * ours taken out.
 *
 * Their own words are what reaches this: `withoutQuotedQuestions` has already
 * taken our question out of the answer, above, before any rule read it. What
 * comes out here is only for the naming rules, because a link is still the
 * person's own writing: today it parses as a path that resolves to nothing and
 * takes the whole answer down with it, which loses the repositories named
 * beside it, and attaching a ticket link is the most ordinary thing an engineer
 * does. Whether they said no, and whether they said a plain yes, are read from
 * their whole reply rather than from this.
 */
function whatThePersonNamed(theirWords: string, catalogKeys: RepositoryKey[]): string {
  return theirWords
    .split("\n")
    .map((line) => withoutForeignLinks(line, catalogKeys))
    .join("\n");
}

/** The line with every link that names no repository taken out. A link to a
 *  ticket, a document or a dashboard no longer speaks for the whole answer;
 *  every link that is a repository keeps resolving. */
function withoutForeignLinks(line: string, catalogKeys: RepositoryKey[]): string {
  return line
    .split(/([\s,]+)/)
    .map((part) => (isForeignLink(normalizeToken(part), catalogKeys) ? "" : part))
    .join("");
}

/** True for a link that names no repository: its host is not one of the two the
 *  provider list knows, AND its path is not a path the catalog holds.
 *
 *  The second half is the narrow part, and it is the reason this drops nothing
 *  a person asked for. A company GitLab is not gitlab.com, so a link there is
 *  indistinguishable from a ticket link by host alone; the catalog tells them
 *  apart. What is left out is a link to a repository the catalog does not hold,
 *  which could not be attached whatever we read it as. */
function isForeignLink(token: string, catalogKeys: RepositoryKey[]): boolean {
  const host = /^https?:\/\/([^/]+)/i.exec(token)?.[1];
  if (host === undefined || PROVIDER_BY_HOST.has(host.toLowerCase().replace(/^www\./, ""))) {
    return false;
  }
  return parseRepositoryExpansionAnswer(token).every(
    (identity) => resolveIdentity(identity, catalogKeys) === null,
  );
}

/**
 * Does this text say no about anything?
 *
 * One of the phrases that is a refusal whole, or any of the words a person says
 * no with, anywhere in what they wrote. It is read on the text with OUR words
 * already taken out: every sentence this system prints about a repository it
 * left out carries a "not", and a person quoting one back is not refusing
 * anything.
 *
 * What it does NOT do, on purpose, is work out which repository the no is
 * about. That question has no reliable answer in free text, and every wrong
 * answer to it is a decision recorded against somebody who said the opposite.
 */
function saysNo(text: string): boolean {
  if (saysNothingToAttach(text)) return true;
  const prose = proseOf(text);
  return (
    NEGATION_WORDS.test(prose) ||
    LEAVE_OUT.test(prose) ||
    KEEP_OUT.test(prose) ||
    OUT_OF_SCOPE.test(prose)
  );
}

/**
 * The person's own words: our question out, and every quoted line with it.
 *
 * `withoutQuotedQuestions` takes out the question we asked, in each form a
 * channel may have rendered it. This adds the other half, which is every line a
 * person quoted at all: the quote button and every mail client write `>`, and
 * what gets quoted here is usually OUR comment saying a repository was left
 * out, a sentence built around the word "not". Read as theirs, it refuses
 * everything, so the reply that is most obviously a yes ("> ... was not taken"
 * / "yes, bring it back") would be the one that never works.
 */
export function withoutQuotedText(answer: string, askedQuestions: string[]): string {
  // OUR QUESTION COMES OUT FIRST, and the quote markers after it. A mail client
  // re-wraps a quoted question and puts its marker in the middle of our
  // sentences, so dropping marked lines first would leave the first half of our
  // own question standing as if the person had typed it.
  //
  // TWO MARKERS, because two channels write them. The mail clients and every
  // markdown editor write ">", and Jira's own wiki markup writes "bq." in front
  // of the quoted line, which is what a person sees when they click quote in a
  // project that never moved to the rich editor.
  return withoutQuotedQuestions(answer, askedQuestions)
    .split("\n")
    .filter((line) => !/^\s*(?:>|bq\.\s)/.test(line))
    .join("\n");
}

/** The words around the repositories a text names, folded for matching. A
 *  repository key is not a sentence: "acme/no-code" carries the letters of a
 *  negation and says nothing, so only the words around the names are read.
 *
 *  Exported for the ticket's own reader (`ticket-text.ts`), which asks a
 *  different question of the same words. One folding, so a repository whose
 *  name carries a phrasing cannot phrase its own exclusion on either path. */
export function proseOf(text: string): string {
  return foldPolishDiacritics(
    text
      .split(/[\s,]+/)
      .filter((token) => !normalizeToken(token).includes("/"))
      .join(" "),
  )
    .toLowerCase()
    .replace(/['’]/g, "");
}

/** True for an answer that says there is nothing to attach.
 *
 *  Deliberately not the same question `isRefusalAnswer` answers for the in-run
 *  expansion protocol, and this is the one place the two callers differ. There,
 *  an answer with no letter and no digit merely ends expansion for that run.
 *  Here it would write a permanent refusal for every repository the question
 *  named, in the name of a person who may have been saying yes, so a check
 *  mark, a thumbs up, "?" and "." are read as nothing said and the person is
 *  asked once more (A34). */
function saysNothingToAttach(answer: string): boolean {
  if (!/[a-z0-9]/i.test(answer)) return false;
  return isRefusalAnswer(answer);
}

function readRepositories(repositoryKeys: RepositoryKey[]): WorkScopeQuestionAnswer {
  if (repositoryKeys.length === 0 || repositoryKeys.length > ANSWER_REPOSITORIES_MAX) {
    return UNRECOGNISED;
  }
  return { kind: "repositories", repositoryKeys };
}

/** The keys a list of bare names resolves to, or null when any token is not
 *  the last path segment of exactly one catalog key. */
function readBareNames(answer: string, catalogKeys: RepositoryKey[]): RepositoryKey[] | null {
  const tokens = answer
    .split(/[\s,]+/)
    .map(normalizeToken)
    .filter((token) => token.length > 0);
  const resolved: RepositoryKey[] = [];
  for (const token of tokens) {
    const matches = catalogKeys.filter((key) => lastPathSegment(key) === token.toLowerCase());
    if (matches.length !== 1) return null;
    resolved.push(matches[0]);
  }
  return resolved.length > 0 ? [...new Set(resolved)] : null;
}

function isAffirmative(answer: string): boolean {
  return AFFIRMATIVE_ANSWERS.has(wholeReply(answer));
}

/** The reply that says every repository the question listed, for a question
 *  whose list the word agrees with. */
function isAllOfThem(answer: string, askedCount: number): boolean {
  const means = ALL_OF_THEM.get(wholeReply(answer));
  if (means === undefined) return false;
  return means === null || means === askedCount;
}

/** The reply as one folded line, for the two sets that are matched whole. */
function wholeReply(answer: string): string {
  return foldPolishDiacritics(answer)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+$/, "");
}

function resolveIdentity(
  identity: ParsedRepositoryIdentity,
  catalogKeys: RepositoryKey[],
): RepositoryKey | null {
  if (identity.provider) {
    const key = repositoryCatalogKey({ provider: identity.provider, path: identity.repoPath });
    return catalogKeys.includes(key) ? key : null;
  }
  const path = identity.repoPath.toLowerCase();
  const matches = catalogKeys.filter((key) => pathOf(key) === path);
  return matches.length === 1 ? matches[0] : null;
}

function pathOf(key: RepositoryKey): string {
  return key.slice(key.indexOf(":") + 1);
}

function lastPathSegment(key: RepositoryKey): string {
  const path = pathOf(key);
  return path.slice(path.lastIndexOf("/") + 1);
}

// The same trim `parseRepositoryExpansionAnswer` applies to each token, so a
// name and an identity are cut out of the answer identically.
function normalizeToken(token: string): string {
  return token.replace(/^[^A-Za-z0-9]+/, "").replace(/[^A-Za-z0-9]+$/, "");
}
