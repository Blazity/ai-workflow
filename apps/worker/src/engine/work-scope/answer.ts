import {
  repositoryCatalogKey,
  type RepositoryKey,
  type WorkScopeQuestionAnswer,
} from "@shared/contracts";
import {
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
]);

/**
 * The one reader of a person's answer to a repository question. Where the
 * answer arrives and the protocol that asked both read it here, so a replay
 * and the record see the same answer.
 *
 * `catalogKeys` are the keys an answer may name: the catalog store's keys plus
 * the keys this question asked about, so a person naming back the repository
 * they were asked about is understood even when the catalog table does not
 * hold it. `askedKeys` are those asked keys alone.
 *
 * A guess is never an answer: an identity the catalog does not hold, a path two
 * providers share, or prose that is not a plain list of names is unrecognised,
 * and the protocol asks its follow-up rather than recording a repository
 * against a person's name.
 */
export function readRepositoryAnswer(
  answer: string,
  input: { catalogKeys: RepositoryKey[]; askedKeys: RepositoryKey[] },
): WorkScopeQuestionAnswer {
  const identities = parseRepositoryExpansionAnswer(answer);
  if (identities.length > 0) {
    const resolved: RepositoryKey[] = [];
    for (const identity of identities) {
      const key = resolveIdentity(identity, input.catalogKeys);
      if (key === null) return UNRECOGNISED;
      resolved.push(key);
    }
    const keys = [...new Set(resolved)];
    // "none, we do not need acme/api" about the very repository the question
    // asked about is a contradiction, not a selection. A refusal word beside a
    // DIFFERENT repository still selects that one.
    if (isRefusalAnswer(answer) && keys.every((key) => input.askedKeys.includes(key))) {
      return UNRECOGNISED;
    }
    return readRepositories(keys);
  }
  if (isRefusalAnswer(answer)) return { kind: "none" };
  // A reply of bare names ("api, web") is how people answer when the question
  // listed the repositories. Every token must be such a name, so a sentence
  // that happens to contain one is not read as a choice.
  const named = readBareNames(answer, input.catalogKeys);
  if (named !== null) return readRepositories(named);
  if (input.askedKeys.length === 1 && isAffirmative(answer)) {
    return { kind: "repositories", repositoryKeys: [input.askedKeys[0]] };
  }
  return UNRECOGNISED;
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
  const whole = answer
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
