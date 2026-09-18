/**
 * ONE READING OF A TICKET'S TEXT, for every reader that has an opinion about it.
 *
 * Two readers look at the words on a ticket: one finds the repository paths in
 * them, and one decides whether those words keep this system OUT of a
 * repository. Until this module existed each read its own copy of the text, and
 * the two disagreed in exactly the way that costs a person a repository:
 *
 *  - the exclusion reader stripped quoted lines and the path finder did not, so
 *    "> Do NOT touch github:acme/api, it is frozen." pasted into a description
 *    was disarmed on one side and matched on the other, and the run cloned the
 *    one repository the ticket had told it to leave alone;
 *  - a person who quoted OUR sentence, "github:acme/api was left out of this
 *    work", and wrote "agreed" underneath had that repository attached, because
 *    the path finder read our own words as theirs.
 *
 * So there is one segmenter and one text. Both readers see the same segments,
 * quotes are handled once, and a change to either rule moves both.
 *
 * WHAT COUNTS AS SAYING NO, and this is the round 6 correction. It used to be
 * any negation word anywhere in the sentence, which reads the most ordinary
 * ticket ever written as a refusal: "Fix the login bug in github:acme/api, but
 * do not deploy yet" dropped api, told the person the ticket said no about it,
 * and left the work undone. Two conditions are now required, and both are about
 * repositories rather than about the word "not":
 *
 *  1. an explicit exclusion phrasing, the way a person writes to keep us out of
 *     a repository (`EXCLUSION_PHRASINGS`, plus the ones that have to see the
 *     repository they govern: `GOVERNS_A_PATH` and
 *     `GOVERNS_A_REPOSITORY_WORD`), and
 *  2. it shares a SEGMENT with the path, where a segment is a phrase rather
 *     than a sentence: "Do NOT touch github:acme/api, it is frozen" protects
 *     api, and "fix api, but do not deploy" does not drop it.
 *
 * What tells the two apart in every case is what the words GOVERN: a repository
 * ("do not touch github:acme/api", "not ops", "bez github:acme/web") or an
 * action ("do not deploy", "don't forget to update github:acme/docs", "nie
 * wdrazaj"). A ticket carries the second beside the repository it is asking for.
 *
 * THE ANSWER PATH IS NOT THIS. A reply to a question we asked carries any
 * negation at all into unreadable (`readRepositoryAnswer` in `answer.ts`),
 * because there the ambiguity is real: the reply is threaded to our question and
 * a "no" in it may be about anything the question offered. A ticket is not a
 * reply to anything, and reading it that strictly is what produced the
 * regression above.
 *
 * Engine tier: contracts and engine siblings only. No database, no clock, no
 * network.
 */
import {
  foldPolishDiacritics,
  parseRepositoryExpansionAnswer,
} from "../repository-discovery/runner.js";
import { proseOf } from "./answer.js";

/** One phrase of a ticket's text, as both readers see it. */
export interface TicketTextSegment {
  /** The words of the segment, quotes already gone. */
  text: string;
  /** True when this segment, or the list header governing it, keeps us out of
   *  the repositories it names. */
  excludes: boolean;
}

/**
 * How a person writes to keep this system OUT of a repository.
 *
 * Built from phrasings somebody would actually type about repository scope, and
 * deliberately NOT from negation words. A bare "not", "never", "forget",
 * "instead" or "rather" is missing on purpose: each of them appears in ordinary
 * ticket prose that asks for work in the repository named beside it, and each of
 * them used to drop that repository. A negation standing directly in front of
 * the repository is the one exception, and it is in `GOVERNS_A_PATH` below.
 *
 * WHAT IS IN THIS LIST IS ABOUT SCOPE RATHER THAN ABOUT AN ACTION, which is why
 * these need no adjacency test of their own: "out of scope", "leave it out",
 * "keep it out", "do not touch" and "nie ruszaj" cannot be aimed at a migration
 * or a failing test. The verbs that can are in `SCOPE_VERB` below, and they
 * count only where they govern the repository.
 *
 * Matched against `proseOf`, which folds Polish diacritics, lowercases, drops
 * apostrophes and removes every token carrying a slash, so a repository called
 * "acme/no-touch" cannot phrase its own exclusion.
 */
const EXCLUSION_PHRASINGS: RegExp[] = [
  // "do not touch", "don't use", "never modify", "no need to open". The verb
  // list is about HAVING the repository, not about what to do inside one: "do
  // not deploy" and "do not merge" are instructions about an action, and a
  // ticket carries them beside the repository it wants worked in.
  /\b(?:do not|dont|never|no need to)\s+(?:touch|use|modify|change|edit|include|open|clone|checkout|check out|work in|work on|go into|add|pull in|bring in)\b/,
  // "leave acme/api out", "keep acme/web out": the repository sits between the
  // two words, so the pair is matched across the segment.
  /\bleave\b.*\bout\b/,
  /\bkeep\b.*\bout\b/,
  /\b(?:out of scope|not in scope|not in the scope|outside the scope)\b/,
  // Polish, in the forms people write them: "nie ruszaj", "nie ruszajcie",
  // "nie dotykaj", "nie uzywaj", "nie zmieniaj".
  /\bnie\s+(?:ruszaj|ruszac|dotykaj|dotykac|uzywaj|uzywac|zmieniaj|zmieniac|edytuj|edytowac|wlaczaj)\w*/,
];

/**
 * The verbs that keep us out only when they GOVERN the repository.
 *
 * "exclude", "skip", "ignore", "pomin", "wyklucz" and the adjective "frozen"
 * take an object, and a ticket names both kinds of object: the repository, and
 * something inside one. Read as bare words they are the same defect as "do not
 * deploy", wearing a different verb:
 *
 *   "Skip the migration in github:acme/api."    lost api
 *   "Ignore the failing test in github:acme/web."  lost web
 *   "The schema is frozen in github:acme/api."  lost api
 *
 * Each of those is a person telling us what not to do INSIDE a repository they
 * are asking us to work in. So the verb counts where it stands in front of the
 * repository itself, spelled out or called one, and nowhere else. The phrasings
 * above need no such test because they are about scope rather than about an
 * action: "out of scope", "leave it out", "do not touch" and the "nie ruszaj"
 * family cannot be aimed at a migration.
 */
const SCOPE_VERB =
  "(?:exclude[sd]?|excluding|skip(?:s|ped|ping)?|ignore[sd]?|ignoring|(?:pomin|pomij)\\w*|wyklucz\\w*)";

/**
 * The words a person refuses with, for the phrasings below that read the
 * segment as written rather than through `proseOf`. They ask the same question
 * the verbs above do, and that is the whole difference between a second thought
 * about a repository and an instruction about an action: "not ops" is the
 * first, "do not deploy" and "don't forget to update github:acme/docs" are the
 * second, and reading those two as refusals is what dropped the repository the
 * ticket was asking for.
 */
const REFUSAL_WORD = "(?:not|no|nie|zaden|zadne)";

/** What a person calls a repository when they do not spell its path out. */
const A_REPOSITORY_WORD = "(?:repos?|repository|repositories|repozytori(?:um|a|ow))";

/** The determiner between the verb and its object, which people write as often
 *  as they leave it out: "skip that repo", "pomin to repozytorium". */
const DETERMINER = "(?:the|that|this|those|these|to|te|ten|tego|tym)\\s+";

/** A repository named as a path, in a segment folded for matching: the token
 *  carries a slash, which is the one shape `proseOf` throws away. */
const A_PATH = "\\S*\\/\\S";

const FROZEN = "(?:frozen|zamrozon\\w*)";

/** The phrasings read on the folded segment, where the paths are still there.
 *  Each one has the repository as the word it governs. */
const GOVERNS_A_PATH: RegExp[] = [
  // "skip github:acme/api", "exclude acme/web", "pomin github:acme/api".
  new RegExp(`\\b${SCOPE_VERB}\\s+(?:${DETERMINER})?${A_PATH}`),
  // "github:acme/api is frozen", "acme/web jest zamrozone".
  new RegExp(`${A_PATH}+\\s+(?:is|are|jest|sa|zostalo|zostaly)\\s+${FROZEN}`),
  // A refusal standing directly in front of a repository: "not
  // github:acme/api", "nie acme/web". Adjacency is the rule and it is not a
  // nicety. One word of distance is all it takes to reach the ordinary ticket:
  // "don't forget to update github:acme/docs" puts a verb between the two, and
  // every phrasing this round was written to stop reads the same way.
  new RegExp(`\\b${REFUSAL_WORD}\\s+(?:the\\s+)?${A_PATH}`),
  // "bez", Polish for "without", and the way a scope is written there: "napraw
  // logowanie bez github:acme/web". It is also the most ordinary preposition in
  // the language, so "napraw github:acme/api bez zmiany schematu" asks for work
  // in api and keeps it: that under-derives by a word of distance and costs a
  // question, where the other way costs the repository.
  new RegExp(`\\bbez\\s+${A_PATH}`),
];

/** The same phrasings where the object is the WORD rather than the path, read
 *  on `proseOf` like the list above it. */
const GOVERNS_A_REPOSITORY_WORD: RegExp[] = [
  // "skip that repo", "exclude the repository", "pomin to repozytorium".
  new RegExp(`\\b${SCOPE_VERB}\\s+(?:${DETERMINER})?${A_REPOSITORY_WORD}\\b`),
  // "the repository is frozen", "repozytorium jest zamrozone".
  new RegExp(`\\b${A_REPOSITORY_WORD}\\b[^\\n]*\\b${FROZEN}`),
];

/** A line a person quoted, in the two markings the channels produce: the ">" of
 *  every mail client and markdown editor, and Jira's own "bq." wiki markup. A
 *  quote written in Jira's rich editor arrives as a blockquote node and is
 *  flattened to "> " lines by the adapter, so it lands here too. */
const QUOTED_LINE = /^\s*(?:>|bq\.\s)/;

/** A list item under a header: a bullet, a dash or a number. */
const LIST_ITEM = /^\s*(?:[-*\u2022]|\d+[.)])\s+/;

/** A header: a line whose words end in a colon. It is what makes "Do not
 *  touch:" govern the paths listed under it. */
const HEADER_LINE = /:\s*$/;

/**
 * Where one phrase ends and the next begins.
 *
 * A comma, a semicolon, the end of a sentence, or a dash standing on its own
 * between spaces. Line breaks split before this, because the carry below is
 * decided per line.
 *
 * A COLON SPLITS ONLY AT THE END OF A PHRASE, never inside a token:
 * "github:acme/api" is one word, and splitting it would put the phrasing and
 * the path on opposite sides of the very test that has to see them together,
 * which is how "Note: do not touch github:acme/api" would have protected
 * nothing.
 *
 * A SENTENCE END IS ALSO A PHRASE END, and leaving it out is what would make
 * this rule worse than the one it replaces: "Fix the billing callback in
 * acme/web. Do NOT touch github:acme/api." holds both repositories in one line,
 * and a reader that split only on commas would find the exclusion beside web
 * and drop the repository the ticket is about. The stop has to be followed by
 * whitespace, so "acme/foo.bar" is one token.
 */
const SEGMENT_BREAK = /[;,]|:(?=\s|$)|(?<=[.!?])\s|\s[-\u2013\u2014]\s/;

/**
 * The ticket's words as both readers see them: quoted lines gone, split into
 * phrases, each phrase carrying whether it keeps us out of what it names.
 *
 * QUOTED LINES ARE DROPPED, for both readers at once. A quote is somebody
 * else's words, and most often it is OURS: every sentence this system writes
 * about a repository it left out is built around a refusal, so reading a quote
 * as the ticket's own words makes our own copy exclude the repository a person
 * is asking for, or attach one they were told about. Dropping them costs the
 * text a person typed INSIDE a quote block, which under-derives: the repository
 * is not taken and nothing is said about it. That is the cheap failure here.
 *
 * A LIST HEADER CARRIES TO ITS ITEMS. "Do not touch:" followed by a bullet list
 * is how a person writes about several repositories at once, and reading each
 * bullet on its own would take every one of them. The carry reaches list items
 * and bare paths alone, and ends at a blank line, at the next header, or at the
 * first line that is neither: a header followed by prose governs nothing, so a
 * paragraph after the list cannot be swallowed by it.
 */
export function ticketTextSegments(text: string): TicketTextSegment[] {
  const segments: TicketTextSegment[] = [];
  let carrying = false;
  for (const line of text.split(/\r?\n/)) {
    if (QUOTED_LINE.test(line)) {
      carrying = false;
      continue;
    }
    if (line.trim().length === 0) {
      carrying = false;
      continue;
    }
    const opensAList = HEADER_LINE.test(line) && excludesWhatItNames(line);
    if (opensAList) carrying = true;
    else if (carrying && (!LIST_ITEM.test(line) || HEADER_LINE.test(line)) && !isBarePath(line)) {
      carrying = false;
    }
    for (const piece of line.split(SEGMENT_BREAK)) {
      if (piece === undefined || piece.trim().length === 0) continue;
      segments.push({ text: piece, excludes: carrying || excludesWhatItNames(piece) });
    }
  }
  return segments;
}

/** Does the text keep us out of a repository it names? The catalog-free form of
 *  the question, for a caller holding a comment and no repository list: a
 *  segment that excludes AND names a path. */
export function ticketTextExcludesARepository(text: string): boolean {
  return ticketTextSegments(text).some(
    (segment) => segment.excludes && namesAPath(segment.text),
  );
}

/** Is this repository named anywhere the run may take it from? */
export function segmentsTakePath(segments: readonly TicketTextSegment[], path: string): boolean {
  return segments.some(
    (segment) => !segment.excludes && mentionsRepositoryPath(segment.text, path),
  );
}

/** Is this repository named at all, taken or kept out? The needle is a
 *  repository path, or the bare name where the caller holds the listing and
 *  reads one. */
export function segmentsNamePath(segments: readonly TicketTextSegment[], path: string): boolean {
  return segments.some((segment) => mentionsRepositoryPath(segment.text, path));
}

/**
 * Does a phrase here put a refusal straight in front of THIS repository's name?
 *
 * The bare-name half of the rule above, and it lives here rather than in
 * `EXCLUSION_PHRASINGS` because it needs the name: "ops" is a repository only
 * to a caller holding the listing, and the catalog-free reader cannot tell it
 * from a team. It is how a person takes a repository back a comment ago, which
 * is the one thing they write that names no path at all: "use github:acme/ops",
 * then "actually not ops".
 *
 * Adjacent, for the reason every phrasing in `GOVERNS_A_PATH` is: the refusal
 * has to govern the repository, or the most ordinary ticket in the world reads
 * as one.
 */
export function segmentsRefuseByName(
  segments: readonly TicketTextSegment[],
  name: string,
): boolean {
  const escaped = foldedOf(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const refusal = new RegExp(`\\b${REFUSAL_WORD}\\s+(?:the\\s+)?${escaped}(?![a-z0-9/_-])`);
  return segments.some((segment) => refusal.test(foldedOf(segment.text)));
}

/**
 * Does this text name this repository path?
 *
 * The one matcher, here rather than beside one of its callers, because "does
 * the text name it" and "do the words around it say no" are two halves of one
 * reading and they have to agree about what the text IS. Bounded on both sides
 * by characters a path cannot contain, so "acme/api" does not match inside
 * "acme/api-gateway".
 */
export function mentionsRepositoryPath(candidateText: string, repoPath: string): boolean {
  const escaped = repoPath.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = "[^a-z0-9/_-]";
  return new RegExp(`(^|${boundary})${escaped}($|${boundary})`).test(candidateText.toLowerCase());
}

/**
 * Does this phrase carry one of the phrasings that keeps us out?
 *
 * TWO READINGS OF THE SAME PHRASE, and the difference between them is the
 * paths. `proseOf` throws every token carrying a slash away, which is what
 * keeps a repository called "acme/no-touch" from phrasing its own exclusion;
 * the phrasings that have to see the repository they govern read `foldedOf`
 * instead, which folds and lowercases and keeps the paths where they are.
 */
function excludesWhatItNames(segment: string): boolean {
  const prose = proseOf(segment);
  if (
    EXCLUSION_PHRASINGS.some((phrasing) => phrasing.test(prose)) ||
    GOVERNS_A_REPOSITORY_WORD.some((phrasing) => phrasing.test(prose))
  ) {
    return true;
  }
  const folded = foldedOf(segment);
  return GOVERNS_A_PATH.some((phrasing) => phrasing.test(folded));
}

/** The phrase folded for matching with its paths intact: Polish diacritics to
 *  ASCII, so "pomin" reaches "pomiń", and lowercased, so the phrasings need no
 *  case flag of their own. */
function foldedOf(segment: string): string {
  return foldPolishDiacritics(segment).toLowerCase();
}

/** Does this phrase name a repository at all? Catalog-free, so it asks the
 *  question the identity parser can answer without one: a token that carries a
 *  slash, a link, or a provider-scoped key. */
function namesAPath(text: string): boolean {
  return parseRepositoryExpansionAnswer(text).length > 0;
}

/** A line that is nothing but repository paths, which is how a list under a
 *  header is written when nobody bothered with bullets. */
function isBarePath(line: string): boolean {
  const tokens = line.trim().split(/[\s,]+/).filter((token) => token.length > 0);
  return tokens.length > 0 && parseRepositoryExpansionAnswer(line).length === tokens.length;
}
