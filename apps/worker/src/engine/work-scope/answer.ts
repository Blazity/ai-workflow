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

// The words a person says no with, compared on word boundaries against what
// they wrote AROUND the repositories they named. Polish is folded to ASCII
// first, so "nie" covers both spellings of its kin. "no need" needs no entry:
// "no" already carries it.
const NEGATION_WORDS =
  /\b(?:no|not|dont|doesnt|wont|cant|without|never|skip|exclude|remove|nie|bez|zaden|zadne)\b/;

// "leave acme/api out" puts the repository between the two words, so the pair
// is matched across the line rather than as one phrase.
const LEAVE_OUT = /\bleave\b[^\n]*\bout\b/;

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
 * A guess is never an answer: an identity the catalog does not hold, a path two
 * providers share, or prose that is not a plain list of names is unrecognised,
 * and the protocol asks its follow-up rather than recording a repository
 * against a person's name. What this reader records outlives the run, so a
 * repeated question is a cost and a fabricated decision is a defect, and every
 * ambiguity here resolves to unrecognised (A34).
 */
export function readRepositoryAnswer(
  answer: string,
  input: {
    catalogKeys: RepositoryKey[];
    askedKeys: RepositoryKey[];
    askedQuestions: string[];
  },
): WorkScopeQuestionAnswer {
  const testimony = whatThePersonNamed(answer, input.askedQuestions, input.catalogKeys);
  const identities = parseRepositoryExpansionAnswer(testimony);
  if (identities.length > 0) {
    const resolved: RepositoryKey[] = [];
    for (const identity of identities) {
      const key = resolveIdentity(identity, input.catalogKeys);
      if (key === null) return UNRECOGNISED;
      resolved.push(key);
    }
    const keys = [...new Set(resolved)];
    if (saysNo(answer, testimony)) {
      // "no, we do not need acme/api" about the very repositories the question
      // asked about is a contradiction, not a selection. A no beside a
      // repository we did NOT ask about is the redirect A30 decided: those are
      // the person's choice, and the asked ones they said no to are dropped.
      const redirected = keys.filter((key) => !input.askedKeys.includes(key));
      if (redirected.length === 0) return UNRECOGNISED;
      return readRepositories(redirected);
    }
    return readRepositories(keys);
  }
  if (saysNothingToAttach(answer)) return { kind: "none" };
  // A reply of bare names ("api, web") is how people answer when the question
  // listed the repositories. Every token must be such a name, so a sentence
  // that happens to contain one is not read as a choice.
  const named = readBareNames(testimony, input.catalogKeys);
  if (named !== null) return readRepositories(named);
  if (input.askedKeys.length === 1 && isAffirmative(answer)) {
    return { kind: "repositories", repositoryKeys: [input.askedKeys[0]] };
  }
  return UNRECOGNISED;
}

/**
 * The answer with the parts that are not the person's testimony taken out, so
 * only the repositories THEY named are read from it.
 *
 * Two parts come out. A line that repeats a question we asked: Jira's quote
 * button produces a blockquote, the adapter flattens the document with no quote
 * marker left on it (`extractAdfText`), so a person who quotes the question and
 * types "no" underneath sends our own repository key back as if they had
 * written it. And a link that is not a repository of ours at all: today it
 * parses as a path that resolves to nothing and takes the whole answer down
 * with it, which loses the repositories named beside it, and attaching a ticket
 * link is the most ordinary thing an engineer does.
 *
 * Only what the answer NAMES is read from this. Whether it says no, and whether
 * it is a plain yes, are read from the whole answer, because either is only
 * itself when it is all the person sent.
 */
function whatThePersonNamed(
  answer: string,
  askedQuestions: string[],
  catalogKeys: RepositoryKey[],
): string {
  const asked = new Set(
    askedQuestions
      .flatMap((question) => question.split("\n"))
      .map(comparableLine)
      .filter((line) => line.length > 0),
  );
  return answer
    .split("\n")
    .filter((line) => !asked.has(comparableLine(line)))
    .map((line) => withoutForeignLinks(line, catalogKeys))
    .join("\n");
}

function comparableLine(line: string): string {
  return line.trim().toLowerCase().replace(/\s+/g, " ");
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

/** True when the answer says no to the repositories it names: one of the
 *  phrases that is a refusal whole, or any of the words a person says no with
 *  written beside them. */
function saysNo(answer: string, testimony: string): boolean {
  if (saysNothingToAttach(answer)) return true;
  // A repository key is not a sentence: "acme/no-code" carries the letters of a
  // negation and says nothing, so only the words around the names are read.
  const prose = foldPolishDiacritics(
    testimony
      .split(/[\s,]+/)
      .filter((token) => !normalizeToken(token).includes("/"))
      .join(" "),
  )
    .toLowerCase()
    .replace(/['’]/g, "");
  return NEGATION_WORDS.test(prose) || LEAVE_OUT.test(prose);
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
  const whole = foldPolishDiacritics(answer)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^a-z0-9]+$/, "");
  return AFFIRMATIVE_ANSWERS.has(whole);
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
